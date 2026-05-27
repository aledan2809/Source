# RFQ Email Sending

## Changelog
- [2026-05-27] v1.0: Send RFQ emails from the UI. Reuses `@aledan/email` (the
  same Nodemailer SMTP module Contakt/RPA-Hub uses) over a configurable SMTP
  transport (Resend SMTP recommended). Two UI surfaces + 3 API routes.

## What it does
Lets the operator send Request-for-Quote emails to suppliers directly from
Source — both from a sourcing result and from a standalone composer.

## Architecture
- **Transport:** `src/lib/email.ts` wraps `@aledan/email` `EmailClient`
  (Nodemailer SMTP). No new send code — reuses the ecosystem module.
  Plain-text RFQ bodies are auto-wrapped to minimal HTML. When SMTP is not
  configured the underlying client logs to console (test mode) and reports
  `smtpConfigured: false` so the UI warns the operator.
- **Send log:** `src/lib/rfq.ts` persists every send to
  `src/data/rfq-sends.json` (gitignored — contains bodies) as `RfqSend[]`.
- **API:**
  - `POST /api/rfq/send` — `{ emails:[{to,subject,body}], resultId?, source? }`
    → sends each, records status, returns `{sent, failed, smtpConfigured, results}`.
  - `GET /api/rfq[?resultId=]` — send history + email-config status.
  - `POST /api/rfq/draft` — `{ context, supplierName?, instructions? }` → AI
    drafts `{subject, body}` (via `runAI`, JSON mode).
- **UI:**
  - Results page `emailuri` tab: per-email **Trimite** button + **Trimite toate**
    (uses the AI-generated `result.emails[]`).
  - Standalone `/rfq`: recipients + subject + body editor, optional AI draft,
    send to many, plus send history. Linked from the home header.
- **Auth:** inherits the app's `ACCESS_TOKEN` middleware (routes + page protected).

## Configuration (env — see `.env.example`)
SMTP is optional; without it, sends are console-logged (dev/test).
```
SMTP_HOST=smtp.resend.com   # Resend SMTP (verified domain required)
SMTP_PORT=465
SMTP_USER=resend
SMTP_PASS=<RESEND_API_KEY>
EMAIL_FROM="Nume Firmă <rfq@your-verified-domain.ro>"
```
Gmail SMTP (app password) also works: `SMTP_HOST=smtp.gmail.com`, `SMTP_USER=you@gmail.com`.

## Notes / future
- One email per recipient (no CC/BCC) — correct for RFQs (suppliers not exposed to each other).
- Attachments not supported in v1 (the spec text is embedded in the body). Adding
  attachments would require extending `@aledan/email` — a shared lib used by
  eCabinet/PRO (NO-TOUCH CRITIC), so it needs the §6.1 propose-confirm-apply path.
- `postinstall` copies `../AIRouter` and `../email-service` into `node_modules`
  (real dirs, not symlinks) so webpack resolves the bare specifiers.
