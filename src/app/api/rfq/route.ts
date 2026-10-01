import { NextRequest, NextResponse } from 'next/server';
import { listSends } from '@/lib/rfq';
import { outreachStatus } from '@/lib/email';

/** GET /api/rfq[?resultId=...] — RFQ send history + whether supplier sending is on. */
export async function GET(request: NextRequest) {
  const resultId = request.nextUrl.searchParams.get('resultId') || undefined;
  const sends = await listSends(resultId);
  const status = outreachStatus();
  return NextResponse.json({
    sendingEnabled: status.ready,
    blockedMessage: status.ready ? null : status.message,
    from: status.ready ? status.from : null,
    sends,
  });
}
