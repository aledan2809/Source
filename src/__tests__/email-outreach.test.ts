/**
 * Unit tests — supplier RFQ e-mails go ONLY through the own outreach mailbox.
 * Run: npx tsx src/__tests__/email-outreach.test.ts
 *
 * No server needed and nothing is ever sent: the SMTP transport is replaced by a
 * fake that only records what it was asked to do. Addresses are fake.
 */

import { promises as fs, existsSync } from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import type { EmailConfig, SendEmailOptions } from '@aledan/email';
import {
  outreachStatus,
  sendRfqEmail,
  OUTREACH_BLOCKED_MESSAGES,
  __setOutreachClientFactoryForTests,
} from '../lib/email';
import { POST as sendRoute } from '../app/api/rfq/send/route';
import { GET as statusRoute } from '../app/api/rfq/route';

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ❌ ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

// ── Fake transport: records, never sends ──
let created: EmailConfig[] = [];
let sentMail: SendEmailOptions[] = [];
let transportBehaviour: 'ok' | 'false' | 'throw' = 'ok';

__setOutreachClientFactoryForTests((config) => {
  created.push(config);
  return {
    async send(options: SendEmailOptions) {
      if (transportBehaviour === 'throw') throw new Error('connection refused');
      if (transportBehaviour === 'false') return false;
      sentMail.push(options);
      return true;
    },
  };
});

const OUTREACH_KEYS = ['OUTREACH_SMTP_HOST', 'OUTREACH_SMTP_PORT', 'OUTREACH_SMTP_USER', 'OUTREACH_SMTP_PASS', 'OUTREACH_SMTP_FROM'];
const env = process.env as Record<string, string | undefined>;

/** Shared Resend SMTP configured (as on VPS2 today), no own mailbox. Fake values. */
function resetEnv() {
  for (const k of OUTREACH_KEYS) delete env[k];
  env.SMTP_HOST = 'smtp.resend.com';
  env.SMTP_PORT = '465';
  env.SMTP_USER = 'resend';
  env.SMTP_PASS = 're_FAKE_shared_key_for_tests';
  env.EMAIL_FROM = 'Source RFQ <rfq@shared.example>';
  env.NODE_ENV = 'development';
  delete env.ACCESS_TOKEN;
  created = [];
  sentMail = [];
  transportBehaviour = 'ok';
}

function ownMailbox(overrides: Record<string, string> = {}) {
  Object.assign(env, {
    OUTREACH_SMTP_HOST: 'mail.own-mailbox.example',
    OUTREACH_SMTP_PORT: '465',
    OUTREACH_SMTP_USER: 'achizitii@own-mailbox.example',
    OUTREACH_SMTP_PASS: 'own-mailbox-password',
    OUTREACH_SMTP_FROM: 'Achiziții <achizitii@own-mailbox.example>',
    ...overrides,
  });
}

const SUPPLIER = 'oferte@furnizor.example';
const rfq = { to: SUPPLIER, subject: 'RFQ: test', body: 'Bună ziua,\nVă rugăm <ofertă>.' };

function postRequest(body: unknown) {
  return new NextRequest('http://localhost:3030/api/rfq/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
    body: JSON.stringify(body),
  });
}

const SENDS_PATH = path.join(process.cwd(), 'src', 'data', 'rfq-sends.json');
async function sendsLogSnapshot(): Promise<string> {
  return existsSync(SENDS_PATH) ? fs.readFile(SENDS_PATH, 'utf8') : '<absent>';
}

async function run() {
  console.log('\n🧪 Source — e-mailuri către furnizori doar prin căsuța proprie\n');

  console.log('📋 Refuz (nimic nu se trimite)');

  await test('fără căsuță proprie: refuzat chiar dacă SMTP_* comun (Resend) e setat', async () => {
    resetEnv();
    const s = outreachStatus();
    assert(!s.ready && s.reason === 'not-configured', `status: ${JSON.stringify(s)}`);
    const r = await sendRfqEmail(rfq);
    assert(!r.ok && r.blocked === true, 'should be blocked');
    assert(r.error === OUTREACH_BLOCKED_MESSAGES['not-configured'], `message: ${r.error}`);
    assert(r.error!.includes('Trimiterea către furnizori e oprită'), 'Romanian stop message');
    assert(created.length === 0 && sentMail.length === 0, 'no transport may be created');
  });

  await test('căsuță proprie incompletă (fără parolă): refuzat', async () => {
    resetEnv();
    ownMailbox();
    delete env.OUTREACH_SMTP_PASS;
    const s = outreachStatus();
    assert(!s.ready && s.reason === 'not-configured', `status: ${JSON.stringify(s)}`);
    assert(!(await sendRfqEmail(rfq)).ok && created.length === 0, 'nothing created');
  });

  for (const [label, overrides] of [
    ['gazda smtp.resend.com', { OUTREACH_SMTP_HOST: 'smtp.resend.com' }],
    ['gazda SMTP.RESEND.COM. (majuscule + punct final)', { OUTREACH_SMTP_HOST: 'SMTP.RESEND.COM.' }],
    ['gazda Brevo smtp-relay.brevo.com', { OUTREACH_SMTP_HOST: 'smtp-relay.brevo.com' }],
    ['gazda Sendinblue', { OUTREACH_SMTP_HOST: 'smtp-relay.sendinblue.com' }],
    ['utilizatorul "resend"', { OUTREACH_SMTP_USER: 'resend' }],
    ['cheie Resend (re_…) ca parolă', { OUTREACH_SMTP_PASS: 're_another_fake_key' }],
    ['cheie Brevo (xsmtpsib-…) ca parolă', { OUTREACH_SMTP_PASS: 'xsmtpsib-fake' }],
  ] as const) {
    await test(`serviciul comun interzis: ${label}`, async () => {
      resetEnv();
      ownMailbox(overrides as Record<string, string>);
      const s = outreachStatus();
      assert(!s.ready && s.reason === 'shared-provider', `status: ${JSON.stringify(s)}`);
      const r = await sendRfqEmail(rfq);
      assert(r.blocked === true && r.error === OUTREACH_BLOCKED_MESSAGES['shared-provider'], `result: ${JSON.stringify(r)}`);
      assert(created.length === 0 && sentMail.length === 0, 'no transport may be created');
    });
  }

  await test('cheia comună copiată, fără prefix recunoscut, sub altă gazdă: refuzat', async () => {
    resetEnv();
    env.SMTP_PASS = 'shared-key-without-prefix';
    ownMailbox({ OUTREACH_SMTP_PASS: 'shared-key-without-prefix' });
    const s = outreachStatus();
    assert(!s.ready && s.reason === 'shared-provider', `status: ${JSON.stringify(s)}`);
  });

  await test('producție fără ACCESS_TOKEN: refuzat (oricine ar putea trimite în numele nostru)', async () => {
    resetEnv();
    ownMailbox();
    env.NODE_ENV = 'production';
    const s = outreachStatus();
    assert(!s.ready && s.reason === 'app-public', `status: ${JSON.stringify(s)}`);
    assert((await sendRfqEmail(rfq)).blocked === true && created.length === 0, 'nothing created');
    env.ACCESS_TOKEN = 'fake-access-token';
    assert(outreachStatus().ready, 'with ACCESS_TOKEN it may send');
  });

  console.log('\n📋 Trimitere prin căsuța proprie (transport fals)');

  await test('trimite doar prin gazda proprie, cu expeditorul propriu', async () => {
    resetEnv();
    ownMailbox();
    const r = await sendRfqEmail({ ...rfq, to: `  ${SUPPLIER}  ` });
    assert(r.ok && !r.blocked, `result: ${JSON.stringify(r)}`);
    assert(created.length === 1, `transports created: ${created.length}`);
    const cfg = created[0];
    assert(cfg.smtpHost === 'mail.own-mailbox.example', `host: ${cfg.smtpHost}`);
    assert(cfg.smtpPort === 465, `port: ${cfg.smtpPort}`);
    assert(cfg.smtpUser === 'achizitii@own-mailbox.example', 'own user');
    assert(cfg.smtpPass === 'own-mailbox-password', 'own password, never the shared key');
    assert(sentMail.length === 1, 'one mail');
    const m = sentMail[0];
    assert(m.to === SUPPLIER, 'recipient trimmed');
    assert(m.from === 'Achiziții <achizitii@own-mailbox.example>', `from: ${m.from}`);
    assert(m.html.includes('&lt;ofertă&gt;') && m.html.includes('<br>'), 'html escaped + line breaks');
    assert(m.text === rfq.body, 'plain text kept');
  });

  await test('portul implicit e 587 când OUTREACH_SMTP_PORT lipsește', async () => {
    resetEnv();
    ownMailbox();
    delete env.OUTREACH_SMTP_PORT;
    await sendRfqEmail(rfq);
    assert(created[0]?.smtpPort === 587, `port: ${created[0]?.smtpPort}`);
  });

  await test('adresă invalidă: nu ajunge la transport', async () => {
    resetEnv();
    ownMailbox();
    const r = await sendRfqEmail({ ...rfq, to: 'nu-e-adresa' });
    assert(!r.ok && !r.blocked && sentMail.length === 0, `result: ${JSON.stringify(r)}`);
  });

  await test('transportul refuză: raportat ca eșuat', async () => {
    resetEnv();
    ownMailbox();
    transportBehaviour = 'false';
    const r = await sendRfqEmail(rfq);
    assert(!r.ok && r.error === 'Trimitere eșuată (SMTP)', `result: ${JSON.stringify(r)}`);
  });

  await test('eroare de transport: jurnalul nu conține adresa furnizorului', async () => {
    resetEnv();
    ownMailbox();
    transportBehaviour = 'throw';
    const lines: string[] = [];
    const orig = { error: console.error, log: console.log, warn: console.warn, info: console.info };
    console.error = console.log = console.warn = console.info = (...a: unknown[]) => { lines.push(a.join(' ')); };
    let r;
    try {
      r = await sendRfqEmail(rfq);
    } finally {
      Object.assign(console, orig);
    }
    assert(!r.ok && r.error === 'connection refused', `result: ${JSON.stringify(r)}`);
    const out = lines.join('\n');
    assert(out.includes('***@furnizor.example'), 'masked domain logged');
    assert(!out.includes('oferte@'), 'full address must not be logged');
  });

  console.log('\n📋 Rute API');

  await test('POST /api/rfq/send fără căsuță proprie: 503, mesaj în română, nimic trimis, nimic scris', async () => {
    resetEnv();
    const before = await sendsLogSnapshot();
    const res = await sendRoute(postRequest({ emails: [rfq, { ...rfq, to: 'vanzari@alt-furnizor.example' }], source: 'manual' }));
    const json = await res.json();
    assert(res.status === 503, `status: ${res.status}`);
    assert(json.blocked === true && json.reason === 'not-configured', `body: ${JSON.stringify(json)}`);
    assert(json.error === OUTREACH_BLOCKED_MESSAGES['not-configured'], 'Romanian message');
    assert(json.sent === 0 && json.failed === 0, 'zero counts');
    assert(created.length === 0 && sentMail.length === 0, 'no transport touched');
    assert((await sendsLogSnapshot()) === before, 'send log must stay unchanged');
  });

  await test('POST /api/rfq/send cu căsuța pe Resend: 503 shared-provider', async () => {
    resetEnv();
    ownMailbox({ OUTREACH_SMTP_HOST: 'smtp.resend.com' });
    const res = await sendRoute(postRequest({ emails: [rfq] }));
    const json = await res.json();
    assert(res.status === 503 && json.reason === 'shared-provider', `status ${res.status} body ${JSON.stringify(json)}`);
    assert(created.length === 0, 'no transport touched');
  });

  await test('GET /api/rfq raportează trimiterea oprită + mesajul', async () => {
    resetEnv();
    const res = await statusRoute(new NextRequest('http://localhost:3030/api/rfq'));
    const json = await res.json();
    assert(json.sendingEnabled === false, 'sendingEnabled false');
    assert(json.blockedMessage === OUTREACH_BLOCKED_MESSAGES['not-configured'], 'message');
    assert(json.from === null, 'no sender exposed when off');
    assert(!('smtpConfigured' in json), 'old flag gone');
  });

  await test('GET /api/rfq cu căsuța proprie: pornit, expeditorul propriu', async () => {
    resetEnv();
    ownMailbox();
    const res = await statusRoute(new NextRequest('http://localhost:3030/api/rfq'));
    const json = await res.json();
    assert(json.sendingEnabled === true && json.blockedMessage === null, `body: ${JSON.stringify({ ...json, sends: undefined })}`);
    assert(json.from === 'Achiziții <achizitii@own-mailbox.example>', 'own sender');
  });

  __setOutreachClientFactoryForTests(null);

  console.log(`\n${'─'.repeat(40)}`);
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(`${'─'.repeat(40)}\n`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
