import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { runClaudeWithQualityRetry } from '@/lib/claude';
import type { AIProviderSelection } from '@/lib/claude';
import { safeUpdateJSON, safeWriteJSON, DATA_PATHS, getResultPath } from '@/lib/file-operations';
import { validateFormData, checkRateLimit } from '@/lib/validation';
import { validateSourcing } from '@/lib/guardrails';
import { createPipeline, transition, computeQualityScore, EVENTS } from '@/lib/pipeline';
import { discoverRealSuppliers, type DiscoveredSupplier } from '@/lib/supplier-discovery';
import { generateLearningContext } from '@/lib/learnings';
import { logger } from '@/lib/logger';

// Normalize URL for comparison (strip trailing slash, www, protocol)
function normalizeUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '').toLowerCase();
}

// Check if a URL is just a homepage (no meaningful path beyond /)
function isHomepageUrl(url: string): boolean {
  if (!url) return true;
  try {
    const parsed = new URL(url);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    return cleanPath === '' || cleanPath === '/';
  } catch {
    return true;
  }
}

// Aggregator / irrelevant supplier blacklist — these are NOT real B2B suppliers for specialized products
const AGGREGATOR_DOMAINS = [
  'olx.ro', 'olx.com',
  'autovit.ro',
  'publi24.ro',
  'lajumate.ro',
  'facebook.com', 'facebook.ro',
  'alibaba.com',
  'aliexpress.com',
  'made-in-china.com',
  'dhgate.com',
  'wish.com',
  'temu.com',
];

// Generic retailers that are NOT relevant for specialized B2B sourcing unless the product matches
const GENERIC_RETAILERS_IRRELEVANT_FOR = new Map<string, string[]>([
  // These stores don't sell ATVs, motorcycles, heavy machinery, etc.
  ['dedeman.ro', ['atv', 'motociclet', 'quad', 'moto-cross', 'motocross', 'utilaj', 'excavator', 'buldozer', 'macara']],
  ['praktiker.ro', ['atv', 'motociclet', 'quad', 'moto-cross', 'motocross', 'utilaj', 'excavator', 'buldozer', 'macara']],
  ['hornbach.ro', ['atv', 'motociclet', 'quad', 'moto-cross', 'motocross', 'utilaj', 'excavator', 'buldozer', 'macara']],
  ['ikea.ro', ['atv', 'motociclet', 'quad', 'moto-cross', 'motocross', 'utilaj', 'excavator', 'auto', 'vehicul']],
]);

// Check if a supplier domain is an aggregator
function isAggregator(url: string): boolean {
  const norm = normalizeUrl(url);
  return AGGREGATOR_DOMAINS.some(d => norm.includes(d));
}

// Check if a generic retailer is irrelevant for the given product description
function isIrrelevantRetailer(url: string, description: string): boolean {
  const norm = normalizeUrl(url);
  const descLower = description.toLowerCase();
  for (const [domain, keywords] of GENERIC_RETAILERS_IRRELEVANT_FOR) {
    if (norm.includes(domain)) {
      return keywords.some(kw => descLower.includes(kw));
    }
  }
  return false;
}

// Check if supplier country/origin violates zone constraint
function violatesZone(supplier: Supplier, zone: string): boolean {
  if (zone === 'global') return false;
  const country = (supplier.country || '').toLowerCase();
  const website = normalizeUrl(supplier.website || '');
  if (zone === 'local' || zone === 'regional') {
    // For local/regional, reject obviously foreign suppliers
    const foreignIndicators = ['china', 'alibaba', 'made-in-china', 'dhgate', 'aliexpress', 'temu'];
    if (foreignIndicators.some(fi => country.includes(fi) || website.includes(fi))) {
      return true;
    }
  }
  return false;
}


// Fetch a product page and extract real price from HTML
async function fetchProductPrice(url: string): Promise<{ price: number; currency: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const html = await res.text();

    // Try structured data first (JSON-LD) — most reliable
    const jsonLdMatch = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
    if (jsonLdMatch) {
      for (const block of jsonLdMatch) {
        try {
          const jsonStr = block.replace(/<script[^>]*>/, '').replace(/<\/script>/, '').trim();
          const ld = JSON.parse(jsonStr);
          const offer = ld?.offers || ld?.Offers || (Array.isArray(ld) ? ld.find((x: Record<string, unknown>) => x?.['@type'] === 'Offer' || x?.['@type'] === 'Product') : null);
          const priceSource = offer?.price || offer?.lowPrice || offer?.offers?.price || offer?.offers?.[0]?.price || ld?.price;
          const currencySource = offer?.priceCurrency || offer?.offers?.priceCurrency || offer?.offers?.[0]?.priceCurrency || ld?.priceCurrency;
          if (priceSource) {
            const price = parseFloat(String(priceSource).replace(/[^0-9.,]/g, '').replace(',', '.'));
            if (price > 0) {
              return { price, currency: currencySource || 'RON' };
            }
          }
        } catch { /* malformed JSON-LD, try next */ }
      }
    }

    // Try meta tags (og:price, product:price)
    const metaPrice = html.match(/<meta[^>]*property=["'](?:og:price:amount|product:price:amount)["'][^>]*content=["']([^"']+)["']/i);
    const metaCurrency = html.match(/<meta[^>]*property=["'](?:og:price:currency|product:price:currency)["'][^>]*content=["']([^"']+)["']/i);
    if (metaPrice?.[1]) {
      const price = parseFloat(metaPrice[1].replace(/[^0-9.,]/g, '').replace(',', '.'));
      if (price > 0) {
        return { price, currency: metaCurrency?.[1] || 'RON' };
      }
    }

    // Try common price patterns in HTML (class="price", itemprop="price", data-price)
    const itempropPrice = html.match(/itemprop=["']price["'][^>]*content=["']([0-9.,]+)["']/i);
    if (itempropPrice?.[1]) {
      const price = parseFloat(itempropPrice[1].replace(',', '.'));
      if (price > 0) {
        const currencyMeta = html.match(/itemprop=["']priceCurrency["'][^>]*content=["']([A-Z]+)["']/i);
        return { price, currency: currencyMeta?.[1] || 'RON' };
      }
    }

    // Try data-price attribute
    const dataPrice = html.match(/data-price=["']([0-9.,]+)["']/i);
    if (dataPrice?.[1]) {
      const price = parseFloat(dataPrice[1].replace(',', '.'));
      if (price > 0) return { price, currency: 'RON' };
    }

    return null;
  } catch {
    return null;
  }
}

interface Supplier {
  name: string;
  website: string;
  productUrl?: string;
  productSearchQuery?: string; // Claude provides this, server does the search
  email: string;
  phone: string;
  country: string;
  priceMin?: number;
  priceMax?: number;
  priceCurrency?: string;
  notes: string;
  urlVerified?: boolean;
  urlSource?: 'searched' | 'verified' | 'unverified';
}

interface Email {
  to: string;
  subject: string;
  body: string;
}

interface SourcingPackage {
  summary: string;
  suppliers: Supplier[];
  rfq: string;
  emails: Email[];
  brief: string;
}

interface ConfirmedSpec {
  description: string;
  type: 'cumparare' | 'inchiriere';
  condition?: 'nou' | 'second-hand' | 'indiferent';
  zone: 'local' | 'regional' | 'global';
  zoneLocation?: string;
  budgetMin?: number;
  budgetMax?: number;
  currency: 'RON' | 'EUR' | 'USD' | 'GBP';
  quantity: number;
  unit: string;
  deadline: string;
  filePaths?: string[];
  clarifications?: Array<{ question: string; answer: string }>;
  summary?: string;
  searchId?: string;
  previousResult?: SourcingPackage;
  refinementFeedback?: string;
}

export async function POST(request: NextRequest) {
  try {
    // Rate limiting (lower limit for generate as it's more expensive)
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
    if (!checkRateLimit(ip, 3, 60000)) { // Max 3 generates per minute
      return NextResponse.json(
        { error: 'Prea multe cereri de generare. Încearcă din nou în câteva minute.' },
        { status: 429 }
      );
    }

    const rawSpec = await request.json();

    // Validate spec (contains form data)
    const validation = validateFormData(rawSpec);
    if (!validation.isValid) {
      return NextResponse.json(
        {
          error: 'Date invalide pentru generare',
          details: validation.errors
        },
        { status: 400 }
      );
    }

    const spec: ConfirmedSpec = rawSpec;
    const provider = (rawSpec.provider as AIProviderSelection) || undefined;

    const zoneLabel = spec.zone === 'local'
      ? `Locală${spec.zoneLocation ? ' — ' + spec.zoneLocation : ''}`
      : spec.zone === 'regional'
      ? `Regională${spec.zoneLocation ? ' — ' + spec.zoneLocation : ''}`
      : 'Globală';

    const learnings = await generateLearningContext(spec.description);

    const budgetLine = spec.budgetMin || spec.budgetMax
      ? `- Buget MAXIM OBLIGATORIU: ${spec.budgetMin || '0'} - ${spec.budgetMax} ${spec.currency} ← RESPECTĂ STRICT, nu depăși acest buget`
      : '- Buget: Nespecificat';

    let userContent = `DESCRIERE: ${spec.description}

DETALII TEHNICE:
- Tip: ${spec.type === 'cumparare' ? 'Cumpărare' : 'Închiriere'}
${spec.type === 'cumparare' && spec.condition ? `- Condiție: ${spec.condition === 'nou' ? 'Nou' : spec.condition === 'second-hand' ? 'Second-hand' : 'Indiferent'}` : ''}
- Zonă: ${zoneLabel}
- Cantitate: ${spec.quantity} ${spec.unit}
- Deadline: ${spec.deadline}
${budgetLine}`;

    if (spec.clarifications && spec.clarifications.length > 0) {
      userContent += '\n\nCLARIFICĂRI:';
      for (const c of spec.clarifications) {
        userContent += `\n- ${c.question}: ${c.answer}`;
      }
    }

    if (spec.summary) {
      userContent += `\n\nSUMAR VALIDAT: ${spec.summary}`;
    }

    if (spec.refinementFeedback && spec.previousResult) {
      userContent += `\n\nACEASTA ESTE O CĂUTARE RAFINATĂ.
FEEDBACK UTILIZATOR: ${spec.refinementFeedback}`;
    }

    // ════════════════════════════════════════════════════════════════════════
    // STEP 1: DISCOVER REAL SUPPLIERS VIA WEB SEARCH (before AI call)
    // This is the core fix: search FIRST, then let AI compile from real data.
    // ════════════════════════════════════════════════════════════════════════
    logger.info('[Generate] Step 1: Discovering real suppliers via web search...');

    const discoveredSuppliers = await discoverRealSuppliers({
      description: spec.description,
      zone: spec.zone,
      zoneLocation: spec.zoneLocation,
      type: spec.type,
      condition: spec.condition,
    });

    logger.info(`[Generate] Found ${discoveredSuppliers.length} verified suppliers from web search`);

    // Build supplier context for AI — real data, not hallucination
    let supplierContext = '';
    if (discoveredSuppliers.length > 0) {
      supplierContext = '\n\nFURNIZORI REALI GĂSIȚI PRIN CĂUTARE WEB (folosește DOAR aceștia, nu inventa alții):\n';
      for (let i = 0; i < discoveredSuppliers.length; i++) {
        const s = discoveredSuppliers[i];
        supplierContext += `\n${i + 1}. ${s.name}`;
        supplierContext += `\n   Website: ${s.website}`;
        if (s.productUrl) supplierContext += `\n   Pagina produs: ${s.productUrl}`;
        if (s.contactEmail) supplierContext += `\n   Email: ${s.contactEmail}`;
        if (s.contactPhone) supplierContext += `\n   Telefon: ${s.contactPhone}`;
        if (s.snippet) supplierContext += `\n   Context: ${s.snippet}`;
        supplierContext += '\n';
      }
    }

    // ════════════════════════════════════════════════════════════════════════
    // STEP 2: AI COMPILES PACKAGE FROM REAL SUPPLIER DATA
    // AI receives pre-searched suppliers and creates RFQ + emails + brief
    // ════════════════════════════════════════════════════════════════════════

    const prompt = `Ești un expert în achiziții și sourcing B2B din România și internațional.

TASK: Compilează un pachet complet de sourcing folosind EXCLUSIV furnizorii reali de mai jos (găsiți prin căutare web automată). NU inventa furnizori noi. NU modifica URL-urile sau datele de contact — folosește exact ce este dat.

${discoveredSuppliers.length > 0
  ? `Ai la dispoziție ${discoveredSuppliers.length} furnizori reali verificați. Folosește-i pe toți (sau pe cei relevanți).`
  : `ATENȚIE: Căutarea web nu a găsit furnizori. Încearcă să recomanzi furnizori pe care îi cunoști CU CERTITUDINE (companii reale, verificabile). Dacă nu ești sigur, returnează o listă goală — NU inventa.`
}

Răspunde DOAR în format JSON valid, fără markdown, fără backticks:
{
  "summary": "Rezumat executiv al cererii de sourcing",
  "suppliers": [
    {
      "name": "Numele exact al furnizorului",
      "website": "https://domeniu-exact.ro",
      "productUrl": "URL-ul exact al paginii de produs (sau gol dacă nu există)",
      "email": "email-ul exact (sau gol)",
      "phone": "telefonul exact (sau gol)",
      "country": "România",
      "notes": "De ce este relevant acest furnizor pentru această cerere"
    }
  ],
  "rfq": "Document RFQ profesional complet (cerere de ofertă formală, cu toate specificațiile tehnice din cererea utilizatorului, cantitate, deadline, condiții de livrare)",
  "emails": [{"to": "email@furnizor.ro", "subject": "Cerere de ofertă — [produs]", "body": "Email profesional personalizat per furnizor"}],
  "brief": "Brief sourcing executiv în format markdown"
}

REGULI:
1. Folosește DOAR furnizorii din lista de mai jos — nu adăuga alții decât dacă lista e goală
2. Păstrează URL-urile EXACT cum sunt — nu le modifica
3. Dacă un furnizor nu are email/telefon, lasă câmpul gol ("")
4. RFQ trebuie să fie profesional, formal, cu toate specificațiile tehnice
5. Emailurile trebuie personalizate per furnizor (menționează produsul specific)
6. Brief-ul trebuie să rezume cererea și furnizorii într-un format executiv
7. ZONĂ: ${zoneLabel} — menționează în RFQ și emails${learnings}
${supplierContext}
---

${userContent}`;

    // Create entry immediately with 'processing' status
    const id = spec.searchId || randomUUID();
    // Directory creation is handled by safeWriteJSON below

    const createdAt = new Date().toISOString();
    const processingEntry = {
      id,
      createdAt,
      updatedAt: createdAt,
      spec,
      result: null,
      status: 'processing',
      refinements: spec.refinementFeedback ? 1 : 0,
      satisfied: false,
    };

    // Safe atomic update of search log (prevents race conditions)
    await safeUpdateJSON(DATA_PATHS.SEARCH_LOG, [], (searchLog: Record<string, unknown>[]) => {
      const existingIdx = searchLog.findIndex((e: Record<string, unknown>) => e.id === id);
      if (existingIdx >= 0) {
        processingEntry.refinements = ((searchLog[existingIdx] as Record<string, unknown>).refinements as number || 0) + (spec.refinementFeedback ? 1 : 0);
        searchLog[existingIdx] = processingEntry;
      } else {
        searchLog.push(processingEntry);
      }
      return searchLog;
    });

    // Write individual result file
    await safeWriteJSON(getResultPath(id), processingEntry);

    // Run AI with quality validation — verify websites actually exist before accepting
    const supplierQualityCheck = async (raw: string): Promise<{ pass: boolean; reason?: string }> => {
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) return { pass: false, reason: 'No JSON in response' };
        const parsed = JSON.parse(jsonMatch[0]);
        const suppliers = parsed.suppliers || [];
        if (suppliers.length === 0) return { pass: false, reason: 'No suppliers returned' };

        // Check supplier names aren't fabricated (generic pattern)
        const genericNames = suppliers.filter((s: Record<string, string>) =>
          /^(ATV|Solar|Quad|Energy|Eco|Tech|Motor|Power|Green)\s+(Romania|Center|Distribution|Sport|Shop|Store)\b/i.test(s.name || '') ||
          /^[A-Z][a-z]+\s+(Romania|București|Bucuresti)\s+SRL$/i.test(s.name || '')
        ).length;
        if (genericNames > suppliers.length * 0.5) {
          return { pass: false, reason: `${genericNames}/${suppliers.length} suppliers have generic/fabricated names` };
        }

        // Verify at least 50% of websites actually respond (HEAD request)
        const websiteUrls = suppliers
          .map((s: Record<string, string>) => s.website)
          .filter((w: string) => w && /^https?:\/\/.+\..+/.test(w.trim()));

        if (websiteUrls.length === 0) {
          return { pass: false, reason: 'No suppliers have website URLs' };
        }

        const verifyResults = await Promise.all(
          websiteUrls.slice(0, 4).map(async (url: string) => {
            try {
              const resp = await fetch(url, {
                method: 'HEAD',
                signal: AbortSignal.timeout(5000),
                redirect: 'follow',
              });
              return resp.ok || resp.status === 403 || resp.status === 405;
            } catch { return false; }
          })
        );
        const verified = verifyResults.filter(Boolean).length;
        const verifyRatio = verified / websiteUrls.length;

        if (verifyRatio < 0.5) {
          return { pass: false, reason: `Only ${verified}/${websiteUrls.length} supplier websites respond (${Math.round(verifyRatio * 100)}% — likely hallucinated)` };
        }

        return { pass: true };
      } catch {
        return { pass: false, reason: 'Failed to parse supplier JSON' };
      }
    };

    runClaudeWithQualityRetry(prompt, supplierQualityCheck, { provider, maxProviderRetries: 3 }).then(async (raw) => {
      let pipeline = createPipeline(id);
      pipeline = transition(pipeline, EVENTS.START)!;   // idle → generate
      pipeline = transition(pipeline, EVENTS.SUCCESS)!;  // generate → parse

      // ── PARSE stage ──
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        pipeline = transition(pipeline, EVENTS.FAILURE)!;
        throw new Error('No JSON in response');
      }
      const result: SourcingPackage = JSON.parse(jsonMatch[0]);
      pipeline = transition(pipeline, EVENTS.SUCCESS)!;  // parse → guardrails
      console.log(`[Pipeline/${id}] Stage: ${pipeline.currentStage}`);

      // ── Pre-filter: remove aggregators, irrelevant retailers, zone violations ──
      if (result.suppliers && result.suppliers.length > 0) {
        const preFilterCount = result.suppliers.length;
        result.suppliers = result.suppliers.filter(s => {
          const url = s.website || '';
          if (isAggregator(url)) {
            console.log(`[Source] Filtered aggregator: ${s.name} (${url})`);
            return false;
          }
          if (isIrrelevantRetailer(url, spec.description)) {
            console.log(`[Source] Filtered irrelevant retailer: ${s.name} (${url}) for "${spec.description}"`);
            return false;
          }
          if (violatesZone(s, spec.zone)) {
            console.log(`[Source] Filtered zone violation: ${s.name} (${s.country}) for zone ${spec.zone}`);
            return false;
          }
          return true;
        });
        if (preFilterCount !== result.suppliers.length) {
          console.log(`[Source] Pre-filter: ${preFilterCount} → ${result.suppliers.length} suppliers`);
        }
      }

      // ── MERGE: Enrich AI result with pre-searched supplier data ──
      // The AI was given real supplier data — now ensure URLs are preserved correctly
      if (result.suppliers && result.suppliers.length > 0) {
        logger.info(`[Source] Enriching ${result.suppliers.length} suppliers with web search data...`);

        // Match AI suppliers back to discovered suppliers by domain/name
        const matchDiscovered = (aiSupplier: Supplier): DiscoveredSupplier | undefined => {
          const aiDomain = aiSupplier.website ? extractDomain(aiSupplier.website) : '';
          const aiName = (aiSupplier.name || '').toLowerCase();
          return discoveredSuppliers.find(d => {
            const dDomain = extractDomain(d.website);
            if (aiDomain && dDomain && aiDomain === dDomain) return true;
            if (aiName && d.name.toLowerCase().includes(aiName)) return true;
            if (aiName && aiName.includes(d.name.toLowerCase())) return true;
            return false;
          });
        };

        // Helper to extract domain
        function extractDomain(url: string): string {
          try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
        }

        await Promise.all(result.suppliers.map(async (s) => {
          const discovered = matchDiscovered(s);

          if (discovered) {
            // Use verified data from web search — don't trust AI modifications
            s.website = discovered.website;
            if (discovered.productUrl && !isHomepageUrl(discovered.productUrl)) {
              s.productUrl = discovered.productUrl;
              s.urlVerified = true;
              s.urlSource = 'searched';
            }
            // Use real contact info if AI didn't have it
            if (!s.email && discovered.contactEmail) s.email = discovered.contactEmail;
            if (!s.phone && discovered.contactPhone) s.phone = discovered.contactPhone;
          }

          // Extract real price from product URL
          if (s.productUrl && !isHomepageUrl(s.productUrl)) {
            const realPrice = await fetchProductPrice(s.productUrl);
            if (realPrice) {
              s.priceMin = realPrice.price;
              s.priceMax = realPrice.price;
              s.priceCurrency = realPrice.currency;
              (s as unknown as Record<string, unknown>).priceSource = 'scraped';
              logger.info(`[Source] Real price for ${s.name}: ${realPrice.price} ${realPrice.currency}`);
            } else {
              s.priceMin = undefined;
              s.priceMax = undefined;
              (s as unknown as Record<string, unknown>).priceSource = 'unavailable';
            }
          } else {
            // No product URL — clear any AI-hallucinated prices
            s.priceMin = undefined;
            s.priceMax = undefined;
            (s as unknown as Record<string, unknown>).priceSource = 'unavailable';
          }

          // Keep productSearchQuery for debugging (renamed to _searchQuery)
          if (s.productSearchQuery) {
            (s as unknown as Record<string, unknown>)._searchQuery = s.productSearchQuery;
          }
          delete s.productSearchQuery;
        }));
        console.log(`[Source] URL search complete.`);
      }

      // ── Post-filter: clean up productUrl that accidentally equals website ──
      for (const s of result.suppliers || []) {
        if (s.productUrl && s.website && normalizeUrl(s.productUrl) === normalizeUrl(s.website)) {
          console.log(`[Source] Cleared productUrl=website duplicate for ${s.name}: ${s.productUrl}`);
          s.productUrl = '';
        }
      }

      // ── Fix emails with empty "to" field ──
      if (result.emails) {
        result.emails = result.emails.filter(e => e.to && e.to.trim() !== '');
      }

      // ── Clear suspicious phone numbers (repeating digit patterns like +40 722 222 222) ──
      for (const s of result.suppliers || []) {
        if (s.phone) {
          const digits = s.phone.replace(/\D/g, '');
          // Check for 3+ consecutive same digits (e.g., 222, 000, 555)
          if (/(\d)\1{2,}/.test(digits) && digits.length >= 6) {
            const uniqueDigits = new Set(digits.split('')).size;
            // If phone has very few unique digits relative to length, it's likely fabricated
            if (uniqueDigits <= 3) {
              console.log(`[Source] Cleared suspicious phone for ${s.name}: ${s.phone}`);
              s.phone = '';
            }
          }
        }
      }

      // ── Guardrails: NeMo service → local fallback (same as Master AI Pipeline) ──
      const guardrailsResult = await validateSourcing(
        (result.suppliers || []).map(s => ({
          name: s.name,
          website: s.website,
          productUrl: s.productUrl,
          email: s.email,
          phone: s.phone,
          country: s.country,
          priceMin: s.priceMin,
          priceMax: s.priceMax,
          priceCurrency: s.priceCurrency,
          notes: s.notes,
          urlVerified: s.urlVerified,
        })),
        { budgetMax: spec.budgetMax, budgetMin: spec.budgetMin, currency: spec.currency, zone: spec.zone },
      );

      let guardrailsWarnings: unknown[] = [];
      if (guardrailsResult.flagged && guardrailsResult.rejected_supplier_indices.length > 0) {
        const rejectedSet = new Set(guardrailsResult.rejected_supplier_indices);
        guardrailsWarnings = guardrailsResult.issues;
        result.suppliers = result.suppliers.filter((_, i) => !rejectedSet.has(i));
        console.log(`[Guardrails/${guardrailsResult.engine}] Rejected ${rejectedSet.size} supplier(s)`);
      }

      // Pipeline: guardrails → verify (already done above with URL checks)
      if (result.suppliers.length === 0) {
        // All suppliers rejected — skip to error result
        console.log(`[Pipeline/${id}] All suppliers rejected by guardrails — saving as failed`);
        const failEntry = {
          id,
          createdAt,
          updatedAt: new Date().toISOString(),
          spec,
          result,
          status: 'needs_review',
          refinements: processingEntry.refinements,
          satisfied: false,
          guardrailsWarnings,
          pipeline: {
            qualityScore: 0,
            qualityDecision: 'fail',
            qualityBreakdown: { base: 0, urlScore: 0, priceScore: 0, contactScore: 0, guardrailsScore: 0 },
            stages: pipeline.stageHistory,
            guardrailsEngine: guardrailsResult.engine,
            supplierCount: 0,
            verifiedCount: 0,
            pricesScraped: 0,
          },
        };
        await safeUpdateJSON(DATA_PATHS.SEARCH_LOG, [], (log: Record<string, unknown>[]) => {
          const idx = log.findIndex((e: Record<string, unknown>) => e.id === id);
          if (idx >= 0) log[idx] = failEntry; else log.push(failEntry);
          return log;
        });
        await safeWriteJSON(getResultPath(id), failEntry);
        return; // Exit background processing
      }

      if (guardrailsResult.flagged) {
        pipeline = transition(pipeline, EVENTS.SUCCESS)!; // Some flagged but has results → proceed
      } else {
        pipeline = transition(pipeline, EVENTS.SUCCESS)!;
      }

      // ── VERIFY stage passed (URL checks already ran above) ──
      pipeline = transition(pipeline, EVENTS.SUCCESS)!; // verify → quality

      // ── QUALITY CHECK stage ──
      const qualityInput = {
        totalSuppliers: result.suppliers.length,
        suppliersWithWebsite: result.suppliers.filter(s => s.website).length,
        suppliersWithVerifiedUrl: result.suppliers.filter(s => s.urlVerified).length,
        suppliersWithScrapedPrice: result.suppliers.filter(s => (s as unknown as Record<string, unknown>).priceSource === 'scraped').length,
        suppliersWithEmail: result.suppliers.filter(s => s.email).length,
        suppliersWithPhone: result.suppliers.filter(s => s.phone).length,
        guardrailsRejected: guardrailsResult.rejected_supplier_indices.length,
        guardrailsFlagged: guardrailsResult.issues.length,
      };
      const quality = computeQualityScore(qualityInput);
      pipeline.qualityScore = quality.score;
      pipeline.supplierCount = result.suppliers.length;
      pipeline.verifiedCount = qualityInput.suppliersWithVerifiedUrl;
      pipeline.pricesScrapedCount = qualityInput.suppliersWithScrapedPrice;
      pipeline.guardrailsResult = {
        engine: guardrailsResult.engine,
        flagged: guardrailsResult.flagged,
        rejected_count: guardrailsResult.rejected_supplier_indices.length,
        issues: guardrailsResult.issues,
      };

      // Quality decision
      if (quality.decision === 'pass') {
        pipeline = transition(pipeline, EVENTS.SUCCESS)!; // quality → done
      } else if (quality.decision === 'flag') {
        pipeline = transition(pipeline, EVENTS.FLAG)!; // quality → review
      }
      // 'fail' case: could retry but for now mark as done with low quality

      console.log(`[Pipeline/${id}] Quality: ${quality.score}/100 (${quality.decision}) | Stages: ${pipeline.stageHistory.length}`);

      const logEntry = {
        id,
        createdAt,
        updatedAt: new Date().toISOString(),
        spec,
        result,
        status: quality.decision === 'flag' ? 'needs_review' : 'pending_validation',
        refinements: processingEntry.refinements,
        satisfied: false,
        ...(guardrailsWarnings.length > 0 ? { guardrailsWarnings } : {}),
        pipeline: {
          qualityScore: quality.score,
          qualityDecision: quality.decision,
          qualityBreakdown: quality.breakdown,
          stages: pipeline.stageHistory,
          guardrailsEngine: guardrailsResult.engine,
          supplierCount: result.suppliers.length,
          verifiedCount: qualityInput.suppliersWithVerifiedUrl,
          pricesScraped: qualityInput.suppliersWithScrapedPrice,
        },
      };

      await safeUpdateJSON(DATA_PATHS.SEARCH_LOG, [], (log: Record<string, unknown>[]) => {
        const idx = log.findIndex((e: Record<string, unknown>) => e.id === id);
        if (idx >= 0) log[idx] = logEntry; else log.push(logEntry);
        return log;
      });
      await safeWriteJSON(getResultPath(id), logEntry);
    }).catch(async (err) => {
      console.error('[Generate] Background generate error:', err);
      try {
        const errorEntry = { ...processingEntry, status: 'error', error: err instanceof Error ? err.message : String(err), updatedAt: new Date().toISOString() };
        await safeWriteJSON(getResultPath(id), errorEntry);
        await safeUpdateJSON(DATA_PATHS.SEARCH_LOG, [], (log: Record<string, unknown>[]) => {
          const idx = log.findIndex((e: Record<string, unknown>) => e.id === id);
          if (idx >= 0) log[idx] = errorEntry; else log.push(errorEntry);
          return log;
        });
      } catch (writeErr) {
        console.error('[Generate] Failed to persist error state:', writeErr);
      }
    });

    return NextResponse.json({ id });
  } catch (error) {
    console.error('Generate API error:', error);
    return NextResponse.json(
      { error: 'A apărut o eroare la generarea pachetului: ' + (error instanceof Error ? error.message : String(error)) },
      { status: 500 }
    );
  }
}
