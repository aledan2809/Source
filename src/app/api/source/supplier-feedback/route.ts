import { NextRequest, NextResponse } from 'next/server';
import { recordSupplierFeedback, analyzeAndExtractRules } from '@/lib/learnings';
import { runClaude } from '@/lib/claude';
import { safeReadJSON, getResultPath } from '@/lib/file-operations';

const SUPPLIER_FEEDBACK_RATE_MAX = 20;
const SUPPLIER_FEEDBACK_RATE_WINDOW_MS = 60_000;
const supplierFeedbackCounters = new Map<string, { count: number; resetAt: number }>();
function checkSupplierFeedbackRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = supplierFeedbackCounters.get(ip);
  if (!entry || entry.resetAt < now) {
    supplierFeedbackCounters.set(ip, { count: 1, resetAt: now + SUPPLIER_FEEDBACK_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= SUPPLIER_FEEDBACK_RATE_MAX) return false;
  entry.count++;
  return true;
}

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
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'local';
  if (!checkSupplierFeedbackRateLimit(ip)) {
    return NextResponse.json({ error: 'Too many requests — try again in a minute' }, { status: 429 });
  }

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

    // Trigger async AI rule extraction (fire and forget)
    analyzeAndExtractRules(async (system: string, user: string) => {
      return await runClaude(`${system}\n\n${user}`);
    }).catch((err) => {
      console.error('[SupplierFeedback] Fire-and-forget rule extraction failed:', err);
    });

    return NextResponse.json({ ok: true, feedbackType });
  } catch (error) {
    console.error('Supplier feedback error:', error);
    return NextResponse.json(
      { error: 'Eroare la salvarea feedback-ului' },
      { status: 500 }
    );
  }
}
