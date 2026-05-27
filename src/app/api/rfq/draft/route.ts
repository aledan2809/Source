import { NextRequest, NextResponse } from 'next/server';
import { checkRateLimit } from '@/lib/validation';
import { runAI } from '@/lib/claude';
import { logger } from '@/lib/logger';

const log = logger.child({ module: 'api/rfq/draft' });

interface DraftPayload {
  /** What we're sourcing — spec summary / product description. */
  context: string;
  /** Optional recipient company name to personalize the greeting. */
  supplierName?: string;
  /** Extra instructions (tone, deadline, language). */
  instructions?: string;
}

const SYSTEM = `Ești asistent de achiziții. Redactezi cereri de ofertă (RFQ) profesioniste, concise, în limba română.
Returnezi STRICT un obiect JSON valid cu cheile "subject" și "body". Fără text în afara JSON-ului.
- "subject": linie de subiect clară (max ~80 caractere), prefixată cu "RFQ:".
- "body": corpul emailului în text simplu (fără HTML), formal, cu: salut, scurtă prezentare a cererii,
  specificațiile-cheie ca listă, ce cerem (preț unitar+total ex-VAT și cu TVA, termen livrare, garanție,
  valabilitate ofertă, confirmare conformitate), și o formulă de încheiere cu [Nume]/[Firmă] ca placeholder.`;

export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  if (!checkRateLimit(`rfq-draft:${ip}`, 10, 60_000)) {
    return NextResponse.json({ error: 'Prea multe cereri — reîncearcă într-un minut' }, { status: 429 });
  }

  let payload: DraftPayload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: 'JSON invalid' }, { status: 400 });
  }

  const context = (payload?.context || '').trim();
  if (!context) {
    return NextResponse.json({ error: 'Lipsește contextul (ce sourcing facem)' }, { status: 400 });
  }

  const userPrompt = [
    `Produs/serviciu cerut:\n${context}`,
    payload.supplierName ? `Destinatar (furnizor): ${payload.supplierName}` : '',
    payload.instructions ? `Instrucțiuni suplimentare: ${payload.instructions}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  try {
    const res = await runAI(SYSTEM, userPrompt, { jsonMode: true });
    let parsed: { subject?: string; body?: string };
    try {
      parsed = JSON.parse(res.content);
    } catch {
      // Some providers wrap JSON in ```json fences — strip and retry once.
      const cleaned = res.content.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      parsed = JSON.parse(cleaned);
    }
    if (!parsed.subject || !parsed.body) {
      return NextResponse.json({ error: 'Răspuns AI incomplet' }, { status: 502 });
    }
    return NextResponse.json({ subject: parsed.subject, body: parsed.body, provider: res.provider });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('RFQ draft failed', { err: msg });
    return NextResponse.json({ error: 'Nu am putut genera RFQ-ul' }, { status: 502 });
  }
}
