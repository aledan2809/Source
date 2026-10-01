/**
 * Email sending for Source — RFQ e-mails to suppliers, via @aledan/email
 * (the same Nodemailer SMTP module Contakt/RPA-Hub uses).
 *
 * Every e-mail Source sends goes to a supplier who did not ask for it: cold B2B
 * outreach. Resend and Brevo both forbid that in their terms, and the shared
 * Resend account (techbiz.ae, 7 apps) reached a 37.9% bounce rate in Sept 2026
 * (limit 4%) — one more push can suspend it for every app. So supplier mail may
 * leave ONLY through an own mailbox, configured by dedicated env vars:
 *
 *   OUTREACH_SMTP_HOST   OUTREACH_SMTP_PORT (default 587; 465 = TLS)
 *   OUTREACH_SMTP_USER   OUTREACH_SMTP_PASS   OUTREACH_SMTP_FROM
 *
 * The old SMTP_* / EMAIL_FROM vars (they held the shared Resend key) are
 * deliberately NOT read here any more. Fail-closed: when the own mailbox is
 * missing, points at Resend/Brevo, or the app is public in production (no
 * ACCESS_TOKEN — anyone could send in our name), nothing is sent and the caller
 * gets a Romanian message. There is no console fallback that pretends a send
 * happened. See Master/knowledge/STRATEGIE-EMAIL-RESEND-BREVO-2026-10-01.md.
 */

import { EmailClient, type EmailConfig, type SendEmailOptions } from '@aledan/email';
import { logger } from './logger';

const log = logger.child({ module: 'email' });

/** The bit of EmailClient we use — lets tests swap in a fake that never sends. */
type OutreachClient = { send(options: SendEmailOptions): Promise<boolean> };
type ClientFactory = (config: EmailConfig) => OutreachClient;

const defaultFactory: ClientFactory = (config) => new EmailClient(config);
let _factory: ClientFactory = defaultFactory;
let _client: OutreachClient | null = null;
let _clientKey = '';

/** Test seam only: replace the transport factory (null restores the real one). */
export function __setOutreachClientFactoryForTests(factory: ClientFactory | null): void {
  _factory = factory ?? defaultFactory;
  _client = null;
  _clientKey = '';
}

// Shared services that must never carry cold outreach (their terms forbid it).
const SHARED_PROVIDER_HOST_RE = /(^|\.)(resend\.com|resend\.dev|brevo\.com|sendinblue\.com)$/i;
// API/SMTP keys of those services, in case one is pasted behind another host name.
const SHARED_PROVIDER_KEY_RE = /^(re_|xkeysib-|xsmtpsib-)/;

export type OutreachBlockReason = 'not-configured' | 'shared-provider' | 'app-public';

export const OUTREACH_BLOCKED_MESSAGES: Record<OutreachBlockReason, string> = {
  'not-configured':
    'Trimiterea către furnizori e oprită până configurăm o căsuță de e-mail proprie. Poți copia mesajul și să-l trimiți tu.',
  'shared-provider':
    'Trimiterea către furnizori e oprită: căsuța setată este serviciul comun de e-mail (Resend sau Brevo), care nu are voie să trimită mesaje nesolicitate. E nevoie de o căsuță proprie. Poți copia mesajul și să-l trimiți tu.',
  'app-public':
    'Trimiterea către furnizori e oprită: aplicația nu are parolă de acces, deci oricine ar putea trimite e-mailuri în numele nostru. Poți copia mesajul și să-l trimiți tu.',
};

export type OutreachStatus =
  | { ready: true; from: string }
  | { ready: false; reason: OutreachBlockReason; message: string };

function env(name: string): string {
  return (process.env[name] || '').trim();
}

function blocked(reason: OutreachBlockReason): OutreachStatus {
  return { ready: false, reason, message: OUTREACH_BLOCKED_MESSAGES[reason] };
}

/** Whether supplier e-mails may be sent right now, and if not, why (in Romanian). */
export function outreachStatus(): OutreachStatus {
  const host = env('OUTREACH_SMTP_HOST').replace(/\.+$/, '');
  const user = env('OUTREACH_SMTP_USER');
  const pass = env('OUTREACH_SMTP_PASS');
  const from = env('OUTREACH_SMTP_FROM');
  if (!host || !user || !pass || !from) return blocked('not-configured');

  const sharedPass = env('SMTP_PASS');
  const reusesSharedKey = Boolean(sharedPass) && pass === sharedPass && SHARED_PROVIDER_HOST_RE.test(env('SMTP_HOST'));
  if (
    SHARED_PROVIDER_HOST_RE.test(host) ||
    user.toLowerCase() === 'resend' ||
    SHARED_PROVIDER_KEY_RE.test(pass) ||
    reusesSharedKey
  ) {
    return blocked('shared-provider');
  }

  if (process.env.NODE_ENV === 'production' && !env('ACCESS_TOKEN')) return blocked('app-public');

  return { ready: true, from };
}

function getClient(): OutreachClient {
  const config: EmailConfig = {
    smtpHost: env('OUTREACH_SMTP_HOST'),
    smtpPort: env('OUTREACH_SMTP_PORT') ? Number(env('OUTREACH_SMTP_PORT')) : 587,
    smtpUser: env('OUTREACH_SMTP_USER'),
    smtpPass: env('OUTREACH_SMTP_PASS'),
    defaultFrom: env('OUTREACH_SMTP_FROM'),
  };
  const key = [config.smtpHost, config.smtpPort, config.smtpUser, config.smtpPass, config.defaultFrom].join('|');
  if (!_client || key !== _clientKey) {
    _client = _factory(config);
    _clientKey = key;
  }
  return _client;
}

/** Recipient domain only — never write supplier addresses to the logs. */
function maskRecipient(to: string): string {
  const at = to.lastIndexOf('@');
  return at > 0 ? `***@${to.slice(at + 1)}` : '***';
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
  /** True when the send was refused before any transport was touched. */
  blocked?: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Send one RFQ email to a supplier, only through the own outreach mailbox.
 * Body may be plain text — HTML is derived automatically. The sender is always
 * OUTREACH_SMTP_FROM; callers cannot choose it (anti-spoofing).
 */
export async function sendRfqEmail(opts: {
  to: string;
  subject: string;
  body: string;
}): Promise<SendResult> {
  const to = (opts.to || '').trim();
  const status = outreachStatus();
  if (!status.ready) {
    return { to, ok: false, blocked: true, error: status.message };
  }
  if (!EMAIL_RE.test(to)) {
    return { to, ok: false, error: 'Adresă de email invalidă' };
  }
  if (!opts.subject?.trim() || !opts.body?.trim()) {
    return { to, ok: false, error: 'Subiect sau corp lipsă' };
  }
  try {
    const ok = await getClient().send({
      to,
      from: status.from,
      subject: opts.subject,
      html: textToHtml(opts.body),
      text: opts.body,
    });
    if (!ok) return { to, ok: false, error: 'Trimitere eșuată (SMTP)' };
    return { to, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('RFQ email send failed', { to: maskRecipient(to), err: msg });
    return { to, ok: false, error: msg };
  }
}
