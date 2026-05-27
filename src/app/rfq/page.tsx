'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface RfqSend {
  id: string;
  to: string;
  subject: string;
  status: 'sent' | 'failed';
  error?: string;
  sentAt: string;
  source: 'sourcing' | 'manual';
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseRecipients(raw: string): string[] {
  return Array.from(
    new Set(
      raw
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter((s) => EMAIL_RE.test(s))
    )
  );
}

export default function RfqPage() {
  const [recipientsRaw, setRecipientsRaw] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [aiContext, setAiContext] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [sending, setSending] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [smtpConfigured, setSmtpConfigured] = useState<boolean | null>(null);
  const [from, setFrom] = useState('');
  const [history, setHistory] = useState<RfqSend[]>([]);

  const recipients = parseRecipients(recipientsRaw);

  async function loadHistory() {
    try {
      const res = await fetch('/api/rfq');
      const json = await res.json();
      setSmtpConfigured(Boolean(json.smtpConfigured));
      setFrom(json.from || '');
      setHistory(Array.isArray(json.sends) ? json.sends : []);
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    loadHistory();
  }, []);

  async function draftWithAI() {
    if (!aiContext.trim()) {
      setBanner('Scrie un context pentru AI (ce sourcing faci)');
      return;
    }
    setDrafting(true);
    setBanner(null);
    try {
      const res = await fetch('/api/rfq/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: aiContext }),
      });
      const json = await res.json();
      if (!res.ok) {
        setBanner(json.error || 'Nu am putut genera RFQ-ul');
        return;
      }
      setSubject(json.subject || '');
      setBody(json.body || '');
      setBanner('Draft generat — verifică și editează înainte de trimitere');
    } catch {
      setBanner('Eroare de rețea la generare');
    } finally {
      setDrafting(false);
    }
  }

  async function send() {
    if (recipients.length === 0) {
      setBanner('Adaugă cel puțin un destinatar cu email valid');
      return;
    }
    if (!subject.trim() || !body.trim()) {
      setBanner('Completează subiectul și mesajul');
      return;
    }
    setSending(true);
    setBanner(null);
    try {
      const res = await fetch('/api/rfq/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source: 'manual',
          emails: recipients.map((to) => ({ to, subject, body })),
        }),
      });
      const json = await res.json();
      if (!res.ok) {
        setBanner(json.error || 'Eroare la trimitere');
        return;
      }
      setBanner(
        `${json.sent} trimise${json.failed ? `, ${json.failed} eșuate` : ''}` +
          (json.smtpConfigured
            ? ''
            : ' — ⚠️ SMTP neconfigurat (mod test: doar logate în consolă, NU trimise real)')
      );
      loadHistory();
    } catch {
      setBanner('Eroare de rețea la trimitere');
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-3xl mx-auto px-4 py-10">
        <div className="flex items-center justify-between mb-2">
          <h1 className="text-2xl font-bold bg-gradient-to-r from-orange-500 to-red-600 bg-clip-text text-transparent">
            Trimite RFQ
          </h1>
          <Link href="/" className="text-sm text-gray-400 hover:text-white transition">
            ← Acasă
          </Link>
        </div>
        <p className="text-sm text-gray-400 mb-6">
          Trimite cereri de ofertă pe email către furnizori, direct din platformă.
        </p>

        {/* SMTP status */}
        <div
          className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
            smtpConfigured === false
              ? 'border-yellow-700 bg-yellow-900/20 text-yellow-300'
              : 'border-gray-800 bg-gray-900 text-gray-300'
          }`}
        >
          {smtpConfigured === null
            ? 'Se verifică configurarea email…'
            : smtpConfigured
            ? `✅ Email configurat · expeditor: ${from}`
            : '⚠️ SMTP neconfigurat — emailurile vor fi doar logate în consolă (mod test). Setează SMTP_HOST/SMTP_USER/SMTP_PASS/EMAIL_FROM în .env.'}
        </div>

        {/* AI draft */}
        <div className="mb-6 rounded-xl border border-gray-800 bg-gray-900 p-4">
          <label className="block text-sm text-gray-400 mb-2">
            Generează RFQ cu AI (opțional)
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={aiContext}
              onChange={(e) => setAiContext(e.target.value)}
              placeholder="Ex: switch 25G datacenter, min 12 porturi, VXLAN/BGP, garanție 3 ani…"
              className="flex-1 px-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
            />
            <button
              onClick={draftWithAI}
              disabled={drafting}
              className="px-4 py-2 rounded-lg text-sm font-medium bg-gray-700 hover:bg-gray-600 disabled:opacity-50 transition"
            >
              {drafting ? 'Se generează…' : 'Generează'}
            </button>
          </div>
        </div>

        {/* Form */}
        <div className="space-y-4">
          <div>
            <label className="block text-sm text-gray-400 mb-1">
              Destinatari{' '}
              <span className="text-gray-600">
                (unul per linie sau separați prin virgulă) — {recipients.length} valizi
              </span>
            </label>
            <textarea
              value={recipientsRaw}
              onChange={(e) => setRecipientsRaw(e.target.value)}
              rows={3}
              placeholder={'office@furnizor1.ro\nvanzari@furnizor2.com'}
              className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none font-mono"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Subiect</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="RFQ: …"
              className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Mesaj</label>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={14}
              placeholder="Corpul cererii de ofertă…"
              className="w-full px-3 py-2 bg-gray-900 border border-gray-800 rounded-lg text-sm text-white placeholder-gray-500 focus:border-orange-500 focus:outline-none"
            />
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={send}
              disabled={sending}
              className="px-5 py-2.5 rounded-lg text-sm font-semibold bg-orange-600 hover:bg-orange-500 disabled:opacity-50 transition"
            >
              {sending ? 'Se trimite…' : `Trimite la ${recipients.length} destinatar${recipients.length === 1 ? '' : 'i'}`}
            </button>
            {banner && <span className="text-sm text-gray-300">{banner}</span>}
          </div>
        </div>

        {/* History */}
        {history.length > 0 && (
          <div className="mt-10">
            <h2 className="text-lg font-semibold mb-3">Istoric trimiteri</h2>
            <div className="space-y-1.5">
              {history.slice(0, 30).map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-3 text-sm border border-gray-800 bg-gray-900 rounded-lg px-3 py-2"
                >
                  <div className="min-w-0">
                    <span className={s.status === 'sent' ? 'text-green-500' : 'text-red-400'}>
                      {s.status === 'sent' ? '✓' : '✕'}
                    </span>{' '}
                    <span className="text-gray-300">{s.to}</span>
                    <span className="text-gray-600"> — {s.subject}</span>
                    {s.error && <span className="text-red-400"> ({s.error})</span>}
                  </div>
                  <span className="text-gray-600 shrink-0">
                    {new Date(s.sentAt).toLocaleString('ro-RO')}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
