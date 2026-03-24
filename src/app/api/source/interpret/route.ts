import { NextRequest, NextResponse } from 'next/server';
import { runClaude, CLAUDE_TIMEOUTS } from '@/lib/claude';
import type { AIProviderSelection } from '@/lib/claude';
import { validateFormData, checkRateLimit } from '@/lib/validation';

export async function POST(request: NextRequest) {
  try {
    // Rate limiting
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!checkRateLimit(ip, 10, 60000)) { // Max 10 requests per minute
      return NextResponse.json(
        { error: 'Prea multe cereri. Încearcă din nou în câteva minute.' },
        { status: 429 }
      );
    }

    const rawData = await request.json();

    // Server-side validation
    const validation = validateFormData(rawData);
    if (!validation.isValid) {
      return NextResponse.json(
        {
          error: 'Date invalide',
          details: validation.errors
        },
        { status: 400 }
      );
    }

    const data = validation.data!;
    const round = data.clarificationRound || 0;

    if (round >= 3) {
      return NextResponse.json({
        understood: true,
        summary: `Cerere: ${data.description}. Tip: ${data.type}. Zonă: ${data.zone}${data.zoneLocation ? ' (' + data.zoneLocation + ')' : ''}. Cantitate: ${data.quantity} ${data.unit}.`,
        proceed: true,
      });
    }

    const zoneLabel = data.zone === 'local'
      ? `Locală${data.zoneLocation ? ' — ' + data.zoneLocation : ''}`
      : data.zone === 'regional'
      ? `Regională${data.zoneLocation ? ' — ' + data.zoneLocation : ''}`
      : 'Globală';

    let userContent = `Cerere de ${data.type === 'cumparare' ? 'cumpărare' : 'închiriere'}:

DESCRIERE: ${data.description}

DETALII:
- Tip: ${data.type === 'cumparare' ? 'Cumpărare' : 'Închiriere'}
${data.type === 'cumparare' && data.condition ? `- Condiție: ${data.condition === 'nou' ? 'Nou' : data.condition === 'second-hand' ? 'Second-hand' : 'Indiferent'}` : ''}
- Zonă: ${zoneLabel}
- Cantitate: ${data.quantity} ${data.unit}
- Deadline: ${data.deadline}
${data.budgetMin || data.budgetMax ? `- Buget: ${data.budgetMin || '?'} - ${data.budgetMax || '?'} ${data.currency}` : '- Buget: Nespecificat'}
${data.filePaths && data.filePaths.length > 0 ? `- Fișiere atașate: ${data.filePaths.join(', ')}` : ''}`;

    if (data.previousQuestions && data.previousAnswers && data.previousQuestions.length > 0) {
      userContent += '\n\nCLARIFICĂRI ANTERIOARE:';
      for (let i = 0; i < data.previousQuestions.length; i++) {
        userContent += `\nÎntrebare: ${data.previousQuestions[i]}`;
        userContent += `\nRăspuns: ${data.previousAnswers[i] || 'Nespecificat'}`;
      }
    }

    const prompt = `Ești un expert în achiziții și sourcing B2B. Analizezi cereri de cumpărare/închiriere și determini dacă ai suficiente informații pentru a genera o listă de furnizori și documente RFQ.

Răspunde DOAR în format JSON valid, fără alte comentarii, fără markdown, fără backticks.

Dacă înțelegi complet cererea și poți genera lista de furnizori, răspunde:
{"understood": true, "summary": "rezumat clar al cererii", "proceed": true}

Dacă ai nevoie de clarificări (maximum 3 întrebări), răspunde:
{"understood": false, "questions": ["Întrebarea 1?", "Întrebarea 2?", "Întrebarea 3?"]}

Întrebările trebuie să fie specifice, concrete și relevante pentru identificarea furnizorilor potriviți.

---

${userContent}`;

    const provider = (rawData.provider as AIProviderSelection) || undefined;
    const raw = await runClaude(prompt, { timeoutMs: CLAUDE_TIMEOUTS.INTERPRET, provider });

    // Extract JSON from response (strip markdown if present)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('No JSON in response');
    const parsed = JSON.parse(jsonMatch[0]);

    return NextResponse.json(parsed);
  } catch (error) {
    console.error('Interpret API error:', error);
    return NextResponse.json(
      { error: 'A apărut o eroare la procesarea cererii: ' + (error instanceof Error ? error.message : String(error)) },
      { status: 500 }
    );
  }
}
