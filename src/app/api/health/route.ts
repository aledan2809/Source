import { NextResponse } from 'next/server';
import { existsSync } from 'fs';
import path from 'path';

export const dynamic = 'force-dynamic';

export async function GET() {
  const checks: Record<string, { status: 'ok' | 'warn' | 'fail'; detail?: string }> = {};

  // Auth configured?
  checks.auth = process.env.ACCESS_TOKEN
    ? { status: 'ok' }
    : { status: 'warn', detail: 'ACCESS_TOKEN not set — app is publicly accessible' };

  // Google CSE configured? (critical for product URL quality)
  const hasGoogleCSE = !!(process.env.GOOGLE_CSE_API_KEY && process.env.GOOGLE_CSE_CX);
  checks.google_cse = hasGoogleCSE
    ? { status: 'ok' }
    : { status: 'warn', detail: 'GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX missing — product URL search will use DuckDuckGo fallback' };

  // AI provider configured?
  const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const hasGeminiKey = !!process.env.GEMINI_API_KEY;
  checks.ai_provider = hasAnthropicKey || hasGeminiKey
    ? { status: 'ok', detail: `Providers: ${[hasAnthropicKey && 'anthropic', hasGeminiKey && 'gemini'].filter(Boolean).join(', ')}` }
    : { status: 'fail', detail: 'No AI API keys configured (ANTHROPIC_API_KEY / GEMINI_API_KEY)' };

  // Data directory exists?
  const dataDir = path.join(process.cwd(), 'src', 'data');
  const resultsDir = path.join(dataDir, 'results');
  checks.data_dir = existsSync(dataDir) && existsSync(resultsDir)
    ? { status: 'ok' }
    : { status: 'fail', detail: 'Data directories missing' };

  // Uploads directory
  const uploadsDir = path.join(process.cwd(), 'uploads');
  checks.uploads_dir = existsSync(uploadsDir) || existsSync(path.join(process.cwd(), 'public', 'uploads'))
    ? { status: 'ok' }
    : { status: 'warn', detail: 'Uploads directory not yet created (will be created on first upload)' };

  // NeMo guardrails
  const nemoPort = process.env.NEMO_GUARDRAILS_PORT || '7779';
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`http://localhost:${nemoPort}/v1/rails/config`, { signal: controller.signal });
    clearTimeout(timer);
    checks.nemo_guardrails = res.ok
      ? { status: 'ok' }
      : { status: 'warn', detail: `NeMo responded with ${res.status}` };
  } catch {
    checks.nemo_guardrails = { status: 'warn', detail: `NeMo not reachable on port ${nemoPort} — using local fallback rules` };
  }

  // Overall status
  const hasFailure = Object.values(checks).some(c => c.status === 'fail');
  const hasWarning = Object.values(checks).some(c => c.status === 'warn');
  const overall = hasFailure ? 'unhealthy' : hasWarning ? 'degraded' : 'healthy';

  return NextResponse.json({
    status: overall,
    timestamp: new Date().toISOString(),
    version: '0.1.0',
    port: 3030,
    checks,
  }, { status: hasFailure ? 503 : 200 });
}
