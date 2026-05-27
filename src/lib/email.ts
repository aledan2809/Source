/**
 * Email sending for Source — reuses @aledan/email (the same Nodemailer SMTP
 * module Contakt/RPA-Hub uses), configured via SMTP_* env vars.
 *
 * Transport-agnostic: point SMTP_HOST at Resend (smtp.resend.com, user "resend",
 * pass = RESEND_API_KEY), Gmail, or any SMTP server. When SMTP is not configured
 * the underlying client falls back to console logging (dev-safe).
 */

import { EmailClient } from '@aledan/email';
import { logger } from './logger';

const log = logger.child({ module: 'email' });

let _client: EmailClient | null = null;

/** True when a real SMTP transport is configured (otherwise console fallback). */
export function emailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER);
}

/** Sender shown on outgoing RFQs. For Resend this MUST be a verified domain. */
export function defaultFrom(): string {
  return process.env.EMAIL_FROM || 'Source RFQ <onboarding@resend.dev>';
}

function getClient(): EmailClient {
  if (_client) return _client;
  _client = new EmailClient({
    smtpHost: process.env.SMTP_HOST,
    smtpPort: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : 587,
    smtpUser: process.env.SMTP_USER,
    smtpPass: process.env.SMTP_PASS,
    defaultFrom: defaultFrom(),
  });
  return _client;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wrap a plain-text RFQ body in minimal, readable HTML (preserves line breaks). */
export function textToHtml(text: string): string {
  const body = escapeHtml(text).replace(/\r?\n/g, '<br>');
  return `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;font-size:14px;line-height:1.6;color:#111;white-space:normal">${body}</div>`;
}

export interface SendResult {
  to: string;
  ok: boolean;
  error?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Send one RFQ email. Body may be plain text — HTML is derived automatically. */
export async function sendRfqEmail(opts: {
  to: string;
  subject: string;
  body: string;
  from?: string;
}): Promise<SendResult> {
  const to = (opts.to || '').trim();
  if (!EMAIL_RE.test(to)) {
    return { to, ok: false, error: 'Adresă de email invalidă' };
  }
  if (!opts.subject?.trim() || !opts.body?.trim()) {
    return { to, ok: false, error: 'Subiect sau corp lipsă' };
  }
  try {
    const ok = await getClient().send({
      to,
      from: opts.from || defaultFrom(),
      subject: opts.subject,
      html: textToHtml(opts.body),
      text: opts.body,
    });
    if (!ok) return { to, ok: false, error: 'Trimitere eșuată (SMTP)' };
    return { to, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('RFQ email send failed', { to, err: msg });
    return { to, ok: false, error: msg };
  }
}
