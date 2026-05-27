import { NextRequest, NextResponse } from 'next/server';
import { listSends } from '@/lib/rfq';
import { emailConfigured, defaultFrom } from '@/lib/email';

/** GET /api/rfq[?resultId=...] — RFQ send history + email-config status. */
export async function GET(request: NextRequest) {
  const resultId = request.nextUrl.searchParams.get('resultId') || undefined;
  const sends = await listSends(resultId);
  return NextResponse.json({
    smtpConfigured: emailConfigured(),
    from: defaultFrom(),
    sends,
  });
}
