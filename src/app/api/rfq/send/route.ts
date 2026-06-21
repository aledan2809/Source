import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/validation';
import { sendRfqEmail, emailConfigured, defaultFrom } from '@/lib/email';
import { recordSends, type RfqSend } from '@/lib/rfq';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'api/rfq/send' });

interface OutgoingEmail {
  to: string;
  subject: string;
  body: string;
}

interface SendPayload {
  emails: OutgoingEmail[];
  resultId?: string;
  source?: 'sourcing' | 'manual';
  // NOTE: a caller-supplied `from` is intentionally NOT accepted — the sender is
  // always forced to defaultFrom() (env) to prevent spoofing through the verified domain.
}

const MAX_EMAILS_PER_REQUEST = 50;

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  // 10 send-requests/min; one request may carry up to MAX_EMAILS_PER_REQUEST emails.
  if (!checkRateLimit(`rfq-send:${ip}`, 10, 60_000)) {
    return NextResponse.json({ error: 'Prea multe cereri — reîncearcă într-un minut' }, { status: 429 });
  }

  let payload: SendPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON invalid' }, { status: 400 });
  }

  const emails = Array.isArray(payload?.emails) ? payload.emails : [];
  if (emails.length === 0) {
    return NextResponse.json({ error: 'Niciun email de trimis' }, { status: 400 });
  }
  if (emails.length > MAX_EMAILS_PER_REQUEST) {
    return NextResponse.json(
      { error: `Maxim ${MAX_EMAILS_PER_REQUEST} emailuri per cerere` },
      { status: 400 }
    );
  }

  const source = payload.source === 'manual' ? 'manual' : 'sourcing';
  const records: Array<Omit<RfqSend, 'id' | 'sentAt'>> = [];
  let sent = 0;
  let failed = 0;

  for (const e of emails) {
    // `from` is always forced to the env-configured sender — never trust the caller (anti-spoof).
    const res = await sendRfqEmail({ to: e.to, subject: e.subject, body: e.body });
    if (res.ok) sent++;
    else failed++;
    records.push({
      resultId: payload.resultId,
      to: (e.to || '').trim(),
      subject: e.subject || '',
      body: e.body || '',
      status: res.ok ? 'sent' : 'failed',
      error: res.error,
      source,
    });
  }

  const saved = await recordSends(records);
  log.info('RFQ batch processed', { sent, failed, configured: emailConfigured() });

  return NextResponse.json({
    sent,
    failed,
    smtpConfigured: emailConfigured(),
    from: defaultFrom(),
    results: saved.map((s) => ({ id: s.id, to: s.to, status: s.status, error: s.error })),
  });
}
