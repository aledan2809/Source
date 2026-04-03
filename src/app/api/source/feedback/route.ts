import { NextRequest, NextResponse } from 'next/server';
import { safeUpdateJSON, safeReadJSON, safeWriteJSON, DATA_PATHS, getResultPath } from '@/lib/file-operations';
import { recordSupplierFeedback, analyzeAndExtractRules } from '@/lib/learnings';
import { runClaude } from '@/lib/claude';

interface FeedbackPayload {
  searchId: string;
  satisfied: boolean;
  feedback?: string;
}

export async function POST(request: NextRequest) {
  try {
    const { searchId, satisfied, feedback }: FeedbackPayload = await request.json();

    // Update search log
    await safeUpdateJSON(DATA_PATHS.SEARCH_LOG, [], (searchLog: Record<string, unknown>[]) => {
      const idx = searchLog.findIndex((e: Record<string, unknown>) => e.id === searchId);
      if (idx >= 0) {
        (searchLog[idx] as Record<string, unknown>).satisfied = satisfied;
        (searchLog[idx] as Record<string, unknown>).status = satisfied ? 'satisfied' : 'unsatisfied';
        if (feedback) (searchLog[idx] as Record<string, unknown>).userFeedback = feedback;
      }
      return searchLog;
    });

    // Update individual result file
    const resultData = await safeReadJSON(getResultPath(searchId), null as unknown as Record<string, unknown>);
    if (resultData) {
      await safeWriteJSON(getResultPath(searchId), {
        ...resultData,
        satisfied,
        status: satisfied ? 'satisfied' : 'unsatisfied',
        ...(feedback ? { userFeedback: feedback } : {}),
      });

      // Feed ALL suppliers from this result into the learning engine
      const result = (resultData as { result?: { suppliers?: Array<{ name: string; website: string }> }; spec?: { description?: string } });
      const suppliers = result.result?.suppliers || [];
      const description = result.spec?.description || '';

      for (let i = 0; i < suppliers.length; i++) {
        const s = suppliers[i];
        let domain = '';
        try { domain = new URL(s.website).hostname.replace(/^www\./, ''); } catch {}

        // If user said "good" → all suppliers get good rating
        // If user said "bad" → all suppliers get bad rating (with the user's comment as reason)
        await recordSupplierFeedback({
          searchId,
          supplierName: s.name,
          supplierDomain: domain,
          rating: satisfied ? 'good' : 'bad',
          comment: !satisfied && feedback ? feedback : undefined,
          productCategory: description.substring(0, 100),
          timestamp: new Date().toISOString(),
        });
      }
    }

    // Legacy patterns (kept for compat)
    if (satisfied && feedback) {
      await safeUpdateJSON(DATA_PATHS.AI_LEARNINGS, { patterns: [] } as { patterns: string[] }, (learnings: { patterns: string[] }) => {
        const pattern = `Căutare reușită: ${feedback}`;
        if (!learnings.patterns.includes(pattern)) {
          learnings.patterns.push(pattern);
          if (learnings.patterns.length > 50) {
            learnings.patterns = learnings.patterns.slice(-50);
          }
        }
        return learnings;
      });
    }

    // Trigger async AI rule extraction (fire and forget)
    analyzeAndExtractRules(async (system: string, user: string) => {
      return await runClaude(`${system}\n\n${user}`);
    }).catch((err) => {
      console.error('[Feedback] Fire-and-forget rule extraction failed:', err);
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('Feedback API error:', error);
    return NextResponse.json(
      { error: 'Eroare la salvarea feedback-ului' },
      { status: 500 }
    );
  }
}
