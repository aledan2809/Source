# RFQ Email Sending

## Changelog
- [2026-10-01] v1.1: Supplier RFQ e-mails go ONLY through an own mailbox
  (`OUTREACH_SMTP_*`). The shared Resend account (and Brevo) is never used —
  their terms forbid cold outreach and the shared account was at 37.9% bounces
  in Sept 2026. Fail-closed: no own mailbox → `POST /api/rfq/send` answers 503
  with a Romanian "copy the message" text, nothing sent, nothing logged. The
  console "test mode" is gone. Old `SMTP_*`/`EMAIL_FROM` are no longer read.
  Strategy: `Master/knowledge/STRATEGIE-EMAIL-RESEND-BREVO-2026-10-01.md` (Pasul 0).
- [2026-05-27] v1.0: Send RFQ emails from the UI. Reuses `@aledan/email` (the
  same Nodemailer SMTP module Contakt/RPA-Hub uses) over a configurable SMTP
  transport (Resend SMTP recommended). Two UI surfaces + 3 API routes.

## What it does
Lets the operator send Request-for-Quote emails to suppliers directly from
Source — both from a sourcing result and from a standalone composer.

## Architecture
- **Transport:** `src/lib/email.ts` wraps `@aledan/email` `EmailClient`
  (Nodemailer SMTP). No new send code — reuses the ecosystem module.
  Plain-text RFQ bodies are auto-wrapped to minimal HTML. The transport is
  built ONLY from `OUTREACH_SMTP_*`; `outreachStatus()` refuses (fail-closed)
  when the own mailbox is missing/incomplete, points at Resend/Brevo (host,
  user `resend`, `re_`/`xkeysib-`/`xsmtpsib-` keys, or the shared `SMTP_PASS`
  reused), or the app runs in production without `ACCESS_TOKEN`. The sender is
  always `OUTREACH_SMTP_FROM`. Supplier addresses are masked in our logs.
- **Send log:** `src/lib/rfq.ts` persists every send to
  `src/data/rfq-sends.json` (gitignored — contains bodies) as `RfqSend[]`.
- **API:**
  - `POST /api/rfq/send` — `{ emails:[{to,subject,body}], resultId?, source? }`
    → sends each, records status, returns `{sent, failed, from, results}`.
    Refused: 503 `{error, blocked:true, reason, sent:0, failed:0}`, nothing recorded.
  - `GET /api/rfq[?resultId=]` — send history + `{sendingEnabled, blockedMessage, from}`.
  - `POST /api/rfq/draft` — `{ context, supplierName?, instructions? }` → AI
    drafts `{subject, body}` (via `runAI`, JSON mode).
- **UI:**
  - Results page `emailuri` tab: per-email **Trimite** button + **Trimite toate**
    (uses the AI-generated `result.emails[]`).
  - Standalone `/rfq`: recipients + subject + body editor, optional AI draft,
    send to many, plus send history. Linked from the home header.
- **Auth:** inherits the app's `ACCESS_TOKEN` middleware (routes + page protected).

## Configuration (env)
Supplier sending is OFF until an own mailbox is configured (and, in production,
`ACCESS_TOKEN` is set — otherwise anyone reaching :3030 could send in our name).
```
OUTREACH_SMTP_HOST=mail.your-own-mailbox.ro   # NOT smtp.resend.com / Brevo
OUTREACH_SMTP_PORT=465                         # default 587
OUTREACH_SMTP_USER=achizitii@your-own-mailbox.ro
OUTREACH_SMTP_PASS=<mailbox password>
OUTREACH_SMTP_FROM="Nume Firmă <achizitii@your-own-mailbox.ro>"
```
Prefer a domain that is NOT techbiz.ae: cold outreach hurts the reputation of the
whole sending domain, and techbiz.ae carries the transactional mail of 7 apps.
`.env.example` still shows the old Resend block (not edited — `.env*` files are
NO-TOUCH); follow this note instead.

Tests (no server, fake transport, nothing sent):
`npx tsx src/__tests__/email-outreach.test.ts`.

## Notes / future
- One email per recipient (no CC/BCC) — correct for RFQs (suppliers not exposed to each other).
- Attachments not supported in v1 (the spec text is embedded in the body). Adding
  attachments would require extending `@aledan/email` — a shared lib used by
  eCabinet/PRO (NO-TOUCH CRITIC), so it needs the §6.1 propose-confirm-apply path.
- `postinstall` copies `../AIRouter` and `../email-service` into `node_modules`
  (real dirs, not symlinks) so webpack resolves the bare specifiers.
