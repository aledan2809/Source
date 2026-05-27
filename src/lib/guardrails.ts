/**
 * Sourcing Guardrails — Local Supplier Validation
 *
 * Ported from Master NeMo Guardrails (mesh/guardrails/nemo/app.py)
 * Provides the same validation as the NeMo /validate/sourcing endpoint
 * but runs locally in TypeScript — no external service dependency.
 *
 * Architecture: NeMo service (port 7779) is tried first for full LLM-powered
 * validation. If unavailable, this module provides identical local rule checks.
 */

/* ═══════════════════════════════════════════════════════════════
   Types
   ═══════════════════════════════════════════════════════════════ */

export interface SupplierInput {
  name: string;
  website?: string;
  productUrl?: string;
  email?: string;
  phone?: string;
  country?: string;
  priceMin?: number;
  priceMax?: number;
  priceCurrency?: string;
  notes?: string;
  urlVerified?: boolean;
}

export interface GuardrailFlag {
  type: string;
  message: string;
}

export interface SupplierIssue {
  supplier_index: number;
  supplier_name: string;
  flags: GuardrailFlag[];
}

export interface GuardrailsResult {
  flagged: boolean;
  issues: SupplierIssue[];
  rejected_supplier_indices: number[];
  passed_supplier_count: number;
  engine: 'nemo' | 'local_sourcing_rules';
}

/* ═══════════════════════════════════════════════════════════════
   Constants (mirrored from Master NeMo app.py)
   ═══════════════════════════════════════════════════════════════ */

// Phone formats that look fake / placeholder
const FAKE_PHONE_PATTERNS = [
  /^\+40\s*XXX/,
  /^0{6,}/,
  /^(\d)\1{7,}/,                   // Repeated digit: 0000000000
  /^\+\d{1,2}\s*000\s*000/,
  /^(\d)\1{2,}.*(\d)\2{2,}/,      // Two groups of repeated digits
];

// Supplier name red flags
const SUSPICIOUS_NAME_PATTERNS = [
  /\b(test|fake|dummy|placeholder|example|lorem|ipsum|furnizor\s+(?:X|A|B|1|2))\b/i,
  /^[A-Z]\s*$/,                    // Single letter
  /Furnizor\s+\d+$/i,
];

// Known aggregator / marketplace domains
const AGGREGATOR_DOMAINS = new Set([
  'olx.ro', 'olx.com', 'facebook.com', 'marketplace.facebook.com',
  'publi24.ro', 'imobiliare.ro', 'okazii.ro', 'merx.ro',
  'anunturi.ro', 'lajumate.ro', 'ofer.ro', 'sentinela.ro',
  'alibaba.com', 'aliexpress.com', 'made-in-china.com',
  'dhgate.com', 'wish.com', 'temu.com',
]);

// Country → expected phone prefix mapping
const COUNTRY_PHONE_PREFIXES: Record<string, string[]> = {
  'România': ['+40', '0040', '07', '02', '03'],
  'Romania': ['+40', '0040', '07', '02', '03'],
  'Germania': ['+49', '0049'],
  'Germany': ['+49', '0049'],
  'Franța': ['+33', '0033'],
  'France': ['+33', '0033'],
  'Italia': ['+39', '0039'],
  'Italy': ['+39', '0039'],
  'Ungaria': ['+36', '0036'],
  'Hungary': ['+36', '0036'],
  'Spania': ['+34', '0034'],
  'Spain': ['+34', '0034'],
  'Austria': ['+43', '0043'],
  'Poland': ['+48', '0048'],
  'Polonia': ['+48', '0048'],
  'Bulgaria': ['+359', '00359'],
  'United Kingdom': ['+44', '0044'],
};

// Conversion rates to EUR (rough) for cross-currency budget check
const TO_EUR: Record<string, number> = {
  EUR: 1.0, RON: 0.20, USD: 0.92, GBP: 1.15, PLN: 0.23, CZK: 0.04, HUF: 0.0025,
};

function toEur(amount: number, currency: string): number {
  return amount * (TO_EUR[currency.toUpperCase()] || 1.0);
}

/* ═══════════════════════════════════════════════════════════════
   NeMo Service — Auto-start & Client
   ═══════════════════════════════════════════════════════════════ */

const NEMO_URL = process.env.NEMO_URL || 'http://localhost:7779';
const NEMO_TIMEOUT = 8000;

// Track NeMo process so we only spawn once
let nemoStarting = false;
let nemoHealthy = false;
let lastHealthCheck = 0;

/**
 * Check if NeMo is running by hitting /health.
 */
async function isNemoRunning(): Promise<boolean> {
  // Cache health check for 30 seconds
  if (nemoHealthy && Date.now() - lastHealthCheck < 30_000) return true;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${NEMO_URL}/health`, { signal: controller.signal });
    clearTimeout(timer);
    const ok = res.ok;
    if (ok) {
      nemoHealthy = true;
      lastHealthCheck = Date.now();
    }
    return ok;
  } catch {
    nemoHealthy = false;
    return false;
  }
}

/**
 * Start NeMo service in background if not already running.
 * Non-blocking — returns immediately, NeMo boots in background.
 */
async function ensureNemoRunning(): Promise<void> {
  if (await isNemoRunning()) return;
  if (nemoStarting) return; // Already booting

  nemoStarting = true;

  try {
    const { spawn } = await import('child_process');
    const pathMod = await import('path');
    const fsMod = await import('fs');
    const nemoDir = pathMod.resolve(process.cwd(), 'nemo');
    const appPath = pathMod.join(nemoDir, 'app.py');

    // Check if app.py exists
    try {
      fsMod.accessSync(appPath);
    } catch {
      console.warn('[NeMo] nemo/app.py not found — skipping auto-start');
      nemoStarting = false;
      return;
    }

    console.log('[NeMo] Service not running — starting in background...');

    // Try python3 first (Linux/VPS), then python (Windows)
    const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';

    const proc = spawn(pythonCmd, [appPath], {
      cwd: nemoDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env: { ...process.env },
    });

    // Catch spawn errors so they don't crash the main process
    proc.on('error', (err) => {
      console.warn(`[NeMo] Failed to spawn: ${err.message}`);
      nemoStarting = false;
    });

    // Don't keep the parent process waiting for NeMo
    proc.unref();

    proc.stdout?.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg) console.log(`[NeMo] ${msg}`);
    });

    proc.stderr?.on('data', (d: Buffer) => {
      const msg = d.toString().trim();
      if (msg && !msg.includes('INFO:')) console.warn(`[NeMo] ${msg}`);
    });

    proc.on('exit', (code) => {
      console.log(`[NeMo] Process exited with code ${code}`);
      nemoHealthy = false;
      nemoStarting = false;
    });

    // Wait up to 8 seconds for NeMo to become healthy
    for (let i = 0; i < 16; i++) {
      await new Promise(r => setTimeout(r, 500));
      if (await isNemoRunning()) {
        console.log(`[NeMo] Service ready (took ${(i + 1) * 0.5}s)`);
        nemoStarting = false;
        return;
      }
    }

    console.warn('[NeMo] Service did not become healthy within 8s — will use local fallback');
  } catch (err) {
    console.warn('[NeMo] Failed to start:', err instanceof Error ? err.message : err);
  }

  nemoStarting = false;
}

/**
 * Try to validate via NeMo service.
 * Auto-starts NeMo if not running.
 * Returns null if NeMo is unavailable (caller should use local fallback).
 */
async function tryNemoValidation(
  suppliers: SupplierInput[],
  budgetMax?: number,
  budgetMin?: number,
  currency?: string,
  zone?: string,
  suspiciouslyLowPriceThreshold?: number,
): Promise<GuardrailsResult | null> {
  // Ensure NeMo is running (auto-start if needed)
  await ensureNemoRunning();

  if (!nemoHealthy) return null;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NEMO_TIMEOUT);
    const res = await fetch(`${NEMO_URL}/validate/sourcing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        suppliers, budgetMax, budgetMin,
        currency: currency || 'EUR',
        zone: zone || 'regional',
        suspiciouslyLowPriceThreshold,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const data = await res.json() as GuardrailsResult;
    data.engine = 'nemo';
    return data;
  } catch {
    nemoHealthy = false; // Mark unhealthy so next call retries
    return null;
  }
}

/* ═══════════════════════════════════════════════════════════════
   Local Sourcing Validation (mirrors Master NeMo local_check_sourcing)
   ═══════════════════════════════════════════════════════════════ */

function localCheckSourcing(
  suppliers: SupplierInput[],
  budgetMax?: number,
  budgetMin?: number,
  currency: string = 'EUR',
  zone: string = 'regional',
  suspiciouslyLowPriceThreshold: number = 0.50,
): GuardrailsResult {
  const issues: SupplierIssue[] = [];
  const rejectedIndices = new Set<number>();

  const budgetMaxEur = budgetMax ? toEur(budgetMax, currency) : null;
  const budgetMinEur = budgetMin ? toEur(budgetMin, currency) : null;

  for (let idx = 0; idx < suppliers.length; idx++) {
    const s = suppliers[idx];
    const supplierFlags: GuardrailFlag[] = [];

    // ── Budget enforcement ──────────────────────────────────────
    if (budgetMaxEur !== null && s.priceMin != null) {
      const priceEur = toEur(s.priceMin, s.priceCurrency || currency);
      if (priceEur > budgetMaxEur * 1.05) { // 5% tolerance
        supplierFlags.push({
          type: 'budget_exceeded',
          message: `priceMin ${s.priceMin} ${s.priceCurrency || currency} > budget max ${budgetMax} ${currency}`,
        });
        rejectedIndices.add(idx);
      }
    }

    // Suspiciously low price (hallucination indicator)
    if (budgetMinEur !== null && s.priceMax != null) {
      const priceEur = toEur(s.priceMax, s.priceCurrency || currency);
      if (priceEur < budgetMinEur * suspiciouslyLowPriceThreshold) {
        supplierFlags.push({
          type: 'price_suspiciously_low',
          message: `priceMax ${s.priceMax} ${s.priceCurrency || currency} is <${Math.round(suspiciouslyLowPriceThreshold * 100)}% of budget min — likely hallucinated`,
        });
      }
    }

    // ── Suspicious supplier name ────────────────────────────────
    const name = s.name || '';
    for (const pat of SUSPICIOUS_NAME_PATTERNS) {
      if (pat.test(name)) {
        supplierFlags.push({ type: 'suspicious_name', message: `Supplier name looks fake: '${name}'` });
        rejectedIndices.add(idx);
        break;
      }
    }

    // ── Empty name ──────────────────────────────────────────────
    if (!name.trim()) {
      supplierFlags.push({ type: 'empty_name', message: 'Supplier name is empty' });
      rejectedIndices.add(idx);
    }

    // ── Fake phone number ───────────────────────────────────────
    const phone = (s.phone || '').trim();
    if (phone) {
      for (const pat of FAKE_PHONE_PATTERNS) {
        if (pat.test(phone)) {
          supplierFlags.push({ type: 'fake_phone', message: `Phone looks fake/placeholder: '${phone}'` });
          break;
        }
      }

      // Country/phone prefix mismatch
      const country = (s.country || '').trim();
      const expected = COUNTRY_PHONE_PREFIXES[country];
      if (expected && !expected.some(p => phone.startsWith(p))) {
        supplierFlags.push({
          type: 'phone_country_mismatch',
          message: `Phone '${phone}' does not match expected prefix for ${country}`,
        });
      }
    }

    // ── Aggregator as product URL ───────────────────────────────
    const productUrl = (s.productUrl || '').trim();
    if (productUrl) {
      try {
        const netloc = new URL(productUrl).hostname.toLowerCase().replace(/^www\./, '');
        if (AGGREGATOR_DOMAINS.has(netloc) || [...AGGREGATOR_DOMAINS].some(agg => netloc.endsWith('.' + agg))) {
          supplierFlags.push({
            type: 'aggregator_url',
            message: `productUrl points to aggregator/marketplace: ${netloc}`,
          });
        }
      } catch { /* invalid URL */ }
    }

    // ── No contact data at all ──────────────────────────────────
    if (!s.website && !s.email && !s.phone && !s.productUrl) {
      supplierFlags.push({ type: 'no_contact_data', message: 'Supplier has no verifiable contact data (no website, email, phone)' });
      rejectedIndices.add(idx);
    }

    // ── Zone consistency: local zone but foreign supplier ───────
    const countryLower = (s.country || '').toLowerCase();
    if (zone === 'local' && countryLower && !['românia', 'romania', ''].includes(countryLower)) {
      supplierFlags.push({
        type: 'zone_mismatch',
        message: `Zone is 'local' but supplier country is '${s.country}'`,
      });
    }

    // ── Duplicate name check ────────────────────────────────────
    const sameNameCount = suppliers.filter(other => other.name === s.name).length;
    if (sameNameCount > 1) {
      supplierFlags.push({ type: 'duplicate_name', message: `Name '${s.name}' appears ${sameNameCount} times` });
    }

    if (supplierFlags.length > 0) {
      issues.push({ supplier_index: idx, supplier_name: s.name, flags: supplierFlags });
    }
  }

  const rejectedArray = [...rejectedIndices];
  return {
    flagged: issues.length > 0,
    issues,
    rejected_supplier_indices: rejectedArray,
    passed_supplier_count: suppliers.length - rejectedArray.length,
    engine: 'local_sourcing_rules',
  };
}

/* ═══════════════════════════════════════════════════════════════
   Public API — Try NeMo first, fallback to local
   ═══════════════════════════════════════════════════════════════ */

/**
 * Validate suppliers against sourcing guardrails.
 *
 * Architecture (same as Master AI Pipeline):
 *   1. Try NeMo Guardrails service (port 7779) — full LLM-powered validation
 *   2. If NeMo unavailable → fall back to local rule-based checks
 *
 * Local checks mirror Master's `local_check_sourcing()` from NeMo app.py:
 *   - Budget enforcement (with 5% tolerance + cross-currency conversion)
 *   - Suspicious name detection (test, fake, dummy, "Furnizor X")
 *   - Empty name rejection
 *   - Fake phone number detection (placeholder patterns, repeated digits)
 *   - Country/phone prefix mismatch
 *   - Aggregator URL detection (OLX, Facebook, Alibaba, etc.)
 *   - No contact data rejection
 *   - Zone mismatch (local zone but foreign supplier)
 *   - Duplicate name detection
 *   - Suspiciously low price (hallucination indicator)
 */
export async function validateSourcing(
  suppliers: SupplierInput[],
  options: {
    budgetMax?: number;
    budgetMin?: number;
    currency?: string;
    zone?: string;
    /** Price below this fraction of budget min = hallucination. Default 0.50 (50%) */
    suspiciouslyLowPriceThreshold?: number;
  } = {},
): Promise<GuardrailsResult> {
  // Stage 1: Try NeMo service (auto-starts if not running)
  const nemoResult = await tryNemoValidation(
    suppliers, options.budgetMax, options.budgetMin, options.currency, options.zone,
    options.suspiciouslyLowPriceThreshold,
  );
  if (nemoResult) {
    console.log(`[Guardrails] NeMo: ${nemoResult.flagged ? 'FLAGGED' : 'PASSED'} (${nemoResult.rejected_supplier_indices.length} rejected)`);
    return nemoResult;
  }

  // Stage 2: Local fallback (same rules as Master NeMo)
  console.log('[Guardrails] NeMo offline — using local sourcing rules');
  const localResult = localCheckSourcing(
    suppliers, options.budgetMax, options.budgetMin, options.currency || 'EUR', options.zone || 'regional',
    options.suspiciouslyLowPriceThreshold ?? 0.50,
  );
  console.log(`[Guardrails] Local: ${localResult.flagged ? 'FLAGGED' : 'PASSED'} (${localResult.rejected_supplier_indices.length} rejected)`);
  return localResult;
}
