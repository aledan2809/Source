import { NextRequest, NextResponse } from 'next/server';
import { recordSupplierFeedback, analyzeAndExtractRules } from '@/lib/learnings';
import { runClaude } from '@/lib/claude';
import { safeReadJSON, getResultPath } from '@/lib/file-operations';

/**
 * POST /api/source/supplier-feedback
 *
 * Accepts 3 types of feedback:
 * - feedbackType: "product"  → Is this product result relevant? (per search result card)
 * - feedbackType: "vendor"   → Is this vendor/company good? (reputation, delivery, reviews)
 *
 * (Result-level feedback is handled by /api/source/feedback)
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { searchId, supplierIndex, rating, comment, feedbackType = 'product' } = body;

    if (!searchId || supplierIndex === undefined || !rating) {
      return NextResponse.json(
        { error: 'Missing required fields: searchId, supplierIndex, rating' },
        { status: 400 }
      );
    }

    if (!['good', 'bad'].includes(rating)) {
      return NextResponse.json({ error: 'Rating must be "good" or "bad"' }, { status: 400 });
    }

    if (!['product', 'vendor'].includes(feedbackType)) {
      return NextResponse.json({ error: 'feedbackType must be "product" or "vendor"' }, { status: 400 });
    }

    // Load the result to get supplier details
    const result = await safeReadJSON<Record<string, unknown> | null>(getResultPath(searchId), null as unknown as Record<string, unknown>);
    if (!result) {
      return NextResponse.json({ error: 'Search result not found' }, { status: 404 });
    }

    const suppliers = ((result as { result?: { suppliers?: Array<{ name: string; website: string }> } }).result?.suppliers) || [];
    const supplier = suppliers[supplierIndex];
    if (!supplier) {
      return NextResponse.json({ error: 'Supplier index out of range' }, { status: 400 });
    }

    let domain = '';
    try { domain = new URL(supplier.website).hostname.replace(/^www\./, ''); } catch {}

    const spec = (result as { spec?: { description?: string } }).spec;
    const productCategory = (spec?.description || '').substring(0, 100);

    // Tag the feedback with its type so learning engine can differentiate
    const commentWithType = feedbackType === 'vendor'
      ? `[VENDOR] ${comment || ''}`
      : `[PRODUCT] ${comment || ''}`;

    await recordSupplierFeedback({
      searchId,
      supplierName: supplier.name,
      supplierDomain: domain,
      rating,
      comment: commentWithType.trim() || undefined,
      productCategory,
      timestamp: new Date().toISOString(),
    });

    // Trigger async AI rule extraction
    analyzeAndExtractRules(async (system: string, user: string) => {
      return await runClaude(`${system}\n\n${user}`);
    }).catch(() => {});

    return NextResponse.json({ ok: true, feedbackType });
  } catch (error) {
    console.error('Supplier feedback error:', error);
    return NextResponse.json(
      { error: 'Eroare la salvarea feedback-ului' },
      { status: 500 }
    );
  }
}
