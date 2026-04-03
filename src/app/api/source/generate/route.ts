import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'crypto';
import { runClaude, runClaudeWithQualityRetry, runAI, CLAUDE_TIMEOUTS } from '@/lib/claude';
import type { AIProviderSelection } from '@/lib/claude';
import { safeReadJSON, safeUpdateJSON, safeWriteJSON, DATA_PATHS, getResultPath } from '@/lib/file-operations';
import { validateFormData, checkRateLimit } from '@/lib/validation';
import { validateSourcing } from '@/lib/guardrails';
import { createPipeline, transition, computeQualityScore, STAGES, EVENTS, type PipelineState } from '@/lib/pipeline';
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
function violatesZone(supplier: Supplier, zone: string, _zoneLocation?: string): boolean {
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

// Romanian stopwords — common words that match URLs but carry no product relevance
const STOPWORDS_RO = new Set([
  'pentru', 'care', 'este', 'sunt', 'acest', 'aceasta', 'într', 'intr', 'cele', 'cele',
  'doar', 'fost', 'avea', 'face', 'poate', 'trebui', 'foarte', 'unde', 'când', 'cand',
  'despre', 'prin', 'după', 'dupa', 'mai', 'cum', 'din', 'sau', 'iar', 'peste',
  'spre', 'între', 'intre', 'fără', 'fara', 'la', 'cu', 'de', 'pe', 'în', 'si', 'și',
  'ale', 'cel', 'cea', 'acesta', 'aceea', 'acele', 'acei', 'acelor', 'acestor',
  'aici', 'atunci', 'exact', 'deci', 'precum', 'special', 'inclusiv', 'minim',
  'maxim', 'până', 'pana', 'oferă', 'oferta', 'gamă', 'gama', 'modele', 'model',
  'zonă', 'zona', 'local', 'locală', 'locala', 'regional', 'regională', 'regionala',
  'buget', 'preț', 'pret', 'livrare', 'termen', 'asap', 'bucată', 'bucata', 'bucăți',
  'piața', 'piata', 'românească', 'romaneasca', 'românia', 'romania', 'bucurești',
  'dealeri', 'autorizați', 'rețele', 'distribuție', 'oficiale', 'branduri',
  'cumpărare', 'cumparare', 'închiriere', 'inchiriere', 'potențial', 'utilizare',
  'capacitate', 'sourcing', 'also', 'with', 'from', 'that', 'this', 'have', 'will',
]);

/**
 * Extract meaningful product keywords from description.
 * Includes short words (like "ATV", "4x4") that are critical product identifiers.
 * Excludes stopwords and generic terms.
 */
function extractProductKeywords(description: string): { primary: string[]; secondary: string[] } {
  const words = description.toLowerCase().split(/[\s,;.()]+/).filter(Boolean);
  const primary: string[] = []; // Core product terms (high value)
  const secondary: string[] = []; // Supporting terms (lower value)

  // Patterns for important short product identifiers
  const shortProductTerms = /^(atv|utv|4x4|2wd|4wd|suv|mpv|led|lcd|cnc|hvac|eps|abs|cvt|rar|ecu|kwh|pv)$/i;
  // Patterns for technical specs that are important
  const techSpecs = /^\d+cc$|^\d+kw$|^\d+kwh?$|^\d+hp$|^\d+[vV]$|^\d+[wW]$|^\d+ah$/;

  for (const w of words) {
    const clean = w.replace(/[^a-zA-Z0-9ăâîșțĂÂÎȘȚ]/g, '');
    if (!clean) continue;
    if (STOPWORDS_RO.has(clean)) continue;

    // Short but critical product terms (e.g., "ATV", "4x4", "CVT")
    if (shortProductTerms.test(clean) || techSpecs.test(clean)) {
      primary.push(clean);
      continue;
    }

    // Very short generic words — skip
    if (clean.length <= 2) continue;

    // 3-char words: only keep if they look like product terms (not generic)
    if (clean.length === 3) {
      if (/^[a-z]{3}$/i.test(clean) && !shortProductTerms.test(clean)) continue; // Skip generic 3-letter words
      primary.push(clean);
      continue;
    }

    // Product-category keywords get primary status
    const productCategoryPattern = /combusti|transmisi|automat|omolog|portant|recreat|competi|motor|vehicul|quad|moto|scuter|tractor|excavat|utilaj|echipament|industrial|electric|hidraulic|pneumatic|generator|compresor|pompa|sudur|frezat|strung|buldozer|macara|încărcăt|stivuitor|inverter|invertoare|panouri|solar|fotovoltaic|baterie|acumulator|monofazat|trifazat|deye|huawei|growatt|sungrow|fronius|victron|mppt|hybrid|on.?grid|off.?grid|litiu|lifepo|kwh|panou|modul|conector|cablu|tablou|prosumator/i;
    if (productCategoryPattern.test(clean)) {
      primary.push(clean);
    } else if (clean.length > 3) {
      secondary.push(clean);
    }
  }

  return { primary, secondary };
}

const GOOGLE_CSE_API_KEY = process.env.GOOGLE_CSE_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || '';

/**
 * Search Google Custom Search API for a real product URL.
 */
async function searchGoogleCSE(
  query: string,
  siteRestrict?: string
): Promise<string | null> {
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_CX) {
    console.warn('[Generate] Google CSE disabled — GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX not set');
    return null;
  }

  const searchQuery = siteRestrict ? `site:${siteRestrict} ${query}` : query;
  const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_CSE_API_KEY}&cx=${GOOGLE_CSE_CX}&q=${encodeURIComponent(searchQuery)}&num=10`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    if (!res.ok) {
      console.error(`[GoogleCSE] API error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const items = data.items || [];

    const nonProductPatterns = [
      /\/blog\//i, /\/news\//i, /\/stiri\//i, /\/contact\b/i, /\/despre\b/i,
      /\/about\b/i, /\/privacy/i, /\/terms/i, /\/cart/i, /\/checkout/i,
      /\/faq/i, /\/support/i, /\/help\//i, /\/livrare\b/i, /\/retur\b/i,
      /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js)$/i,
    ];

    for (const item of items) {
      const link: string = item.link || '';
      if (!link) continue;
      if (isHomepageUrl(link)) continue;
      if (isAggregator(link)) continue;
      try {
        const p = new URL(link).pathname;
        if (nonProductPatterns.some(pat => pat.test(p))) continue;
      } catch { continue; }
      return link;
    }

    return null;
  } catch (err) {
    console.error('[GoogleCSE] Fetch error:', err);
    return null;
  }
}

/**
 * Search DuckDuckGo HTML for a real product URL (free, no API key needed).
 */
async function searchDuckDuckGo(query: string): Promise<string | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
      },
    });
    clearTimeout(timer);

    if (!res.ok) return null;

    const html = await res.text();
    const links: string[] = [];

    // Extract result links from DDG HTML (uses protocol-relative //duckduckgo.com/... URLs)
    const allHrefs = html.matchAll(/href="((?:https?:)?\/\/[^"]+)"/gi);
    for (const m of allHrefs) {
      let href = m[1];
      if (href.startsWith('//')) href = 'https:' + href;
      if (href.includes('duckduckgo.com')) {
        const uddgMatch = href.match(/uddg=([^&]+)/);
        if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);
        else continue;
      }
      if (href.startsWith('http') && !links.includes(href)) links.push(href);
    }

    const nonProductPatterns = [
      /\/blog\//i, /\/news\//i, /\/stiri\//i, /\/contact\b/i, /\/despre\b/i,
      /\/about\b/i, /\/privacy/i, /\/terms/i, /\/cart/i, /\/checkout/i,
      /\/faq/i, /\/support/i, /\/help\//i, /\/livrare\b/i, /\/retur\b/i,
      /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js)$/i,
    ];

    for (const link of links) {
      if (isHomepageUrl(link)) continue;
      if (isAggregator(link)) continue;
      try {
        const p = new URL(link).pathname;
        if (nonProductPatterns.some(pat => pat.test(p))) continue;
      } catch { continue; }
      return link;
    }

    return null;
  } catch (err) {
    console.error('[DuckDuckGo] Fetch error:', err);
    return null;
  }
}

/**
 * Find real product URLs using Google Custom Search API (primary) + website crawling (fallback).
 *
 * Strategy per supplier:
 * 1. [PRIMARY] Google CSE with site:domain + product keywords
 * 2. [FALLBACK] Crawl supplier website HTML (homepage + category pages)
 * 3. Score links by product relevance (keywords, URL patterns)
 * 4. Require at least one primary keyword match for confidence
 * 5. Apply negative scoring for clearly irrelevant product categories
 */
async function findProductUrls(
  suppliers: Array<{ name: string; website: string; productSearchQuery?: string }>,
  productDescription: string
): Promise<Record<number, { productUrl: string; website: string }>> {
  const map: Record<number, { productUrl: string; website: string }> = {};
  const { primary: primaryKeywords, secondary: secondaryKeywords } = extractProductKeywords(productDescription);

  // Also extract search query keywords per supplier
  const extractSearchKeywords = (query?: string): string[] => {
    if (!query) return [];
    return query.toLowerCase()
      .replace(/^site:\S+\s*/i, '') // Remove "site:domain.ro" prefix
      .split(/[\s,;.()]+/)
      .filter(w => w.length > 2 && !STOPWORDS_RO.has(w));
  };

  console.log(`[ProductSearch] Primary keywords: [${primaryKeywords.join(', ')}]`);
  console.log(`[ProductSearch] Secondary keywords: [${secondaryKeywords.join(', ')}]`);

  // Global timeout: 35 seconds for ALL supplier URL searches (Google CSE + DuckDuckGo + crawl)
  const globalTimeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 35000));

  const crawlWork = Promise.allSettled(
    suppliers.map(async (s, i) => {
      if (!s.website) return;

      try {
        const searchKw = extractSearchKeywords(s.productSearchQuery);
        const hostname = new URL(s.website).hostname;

        // ── PRIMARY: Google Custom Search API ──
        if (GOOGLE_CSE_API_KEY && GOOGLE_CSE_CX) {
          const googleQuery = s.productSearchQuery
            ? s.productSearchQuery.replace(/^site:\S+\s*/i, '')
            : primaryKeywords.join(' ');

          // Try with site restriction first
          let googleUrl = await searchGoogleCSE(googleQuery, hostname);

          // If no result with site restriction, try supplier name + product keywords
          if (!googleUrl) {
            googleUrl = await searchGoogleCSE(`${s.name} ${googleQuery}`);
          }

          if (googleUrl && !isHomepageUrl(googleUrl)) {
            console.log(`[GoogleCSE] ${s.name}: found ${googleUrl}`);
            map[i] = { productUrl: googleUrl, website: s.website };
            return; // Skip other strategies
          }
        }

        // ── SECONDARY: DuckDuckGo search (free, no API key needed) ──
        // Build specific product query combining primary keywords
        const ddgProductTerms = s.productSearchQuery
          ? s.productSearchQuery.replace(/^site:\S+\s*/i, '')
          : primaryKeywords.slice(0, 5).join(' ');

        // Strategy 1: site-restricted search with product terms
        let ddgUrl = await searchDuckDuckGo(`site:${hostname} ${ddgProductTerms}`);

        // Strategy 2: supplier name + full product description keywords
        if (!ddgUrl) {
          ddgUrl = await searchDuckDuckGo(`${s.name} ${ddgProductTerms} cumpara pret`);
        }

        // Strategy 3: direct product search without site restriction
        if (!ddgUrl) {
          ddgUrl = await searchDuckDuckGo(`${ddgProductTerms} ${hostname.replace('www.', '')} produs`);
        }

        if (ddgUrl && !isHomepageUrl(ddgUrl)) {
          console.log(`[DuckDuckGo] ${s.name}: found ${ddgUrl}`);
          map[i] = { productUrl: ddgUrl, website: s.website };
          return; // Skip crawl fallback
        }

        const baseUrl = new URL(s.website).origin;

        // Fetch the website homepage
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(s.website, {
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html',
          },
        });
        clearTimeout(timer);
        if (!res.ok) return;

        const html = await res.text();

        // Quick relevance check: does the homepage mention ANY primary keyword?
        const htmlLower = html.toLowerCase();
        const homepageRelevant = primaryKeywords.some(kw => htmlLower.includes(kw));
        if (!homepageRelevant) {
          console.log(`[ProductSearch] ${s.name}: homepage does NOT mention any primary keyword — likely irrelevant supplier`);
          // Still set website for verification, but no product URL
          map[i] = { productUrl: '', website: s.website };
          return;
        }

        // Extract all links from the page
        const extractLinks = (pageHtml: string): string[] => {
          const linkMatches = pageHtml.matchAll(/href=["']([^"']+)["']/gi);
          const found: string[] = [];
          for (const m of linkMatches) {
            let href = m[1];
            // Skip protocol-relative URLs (//cdn.example.com) and external resources
            if (href.startsWith('//')) continue;
            if (href.startsWith('/')) href = baseUrl + href;
            // Only include links from the same domain
            if (href.startsWith('http') && href.includes(hostname)) {
              // Skip obvious non-page resources
              if (/\.(css|js|woff2?|ttf|eot|ico|svg|png|jpg|jpeg|gif|webp|avif)(\?|$)/i.test(href)) continue;
              if (href.includes('fonts.googleapis.com') || href.includes('cdn.') || href.includes('assets.')) continue;
              found.push(href);
            }
          }
          return [...new Set(found)]; // Deduplicate
        };

        let allLinks = extractLinks(html);

        // Phase 2: Also crawl category/product listing pages for deeper product links
        const categoryPatterns = [
          /\/categori/i, /\/categ\//i, /\/produse\b/i, /\/products\b/i,
          /\/shop\b/i, /\/magazin\b/i, /\/catalog\b/i, /\/gama\b/i,
          /\/modele\b/i, /\/range\b/i, /\/lineup\b/i,
          /\/echipamente\b/i, /\/solutii\b/i, /\/oferte\b/i,
          /\/invertor/i, /\/inverter/i, /\/panouri/i, /\/baterii/i,
          /\/fotovoltaic/i, /\/solar\b/i, /\/rezidential/i,
          /\/search\?/i, /\/cautare\?/i, // Internal search pages
        ];
        const categoryLinks = allLinks.filter(link => {
          const path = new URL(link).pathname.toLowerCase();
          return categoryPatterns.some(p => p.test(path));
        });

        // Also look for category links that contain primary keywords
        const keywordCategoryLinks = allLinks.filter(link => {
          const pathLower = new URL(link).pathname.toLowerCase();
          return primaryKeywords.some(kw => pathLower.includes(kw));
        });

        const pagesToCrawl = [...new Set([...categoryLinks, ...keywordCategoryLinks])].slice(0, 5); // Max 5 extra pages

        if (pagesToCrawl.length > 0) {
          console.log(`[ProductSearch] ${s.name}: crawling ${pagesToCrawl.length} category page(s)`);
          const categoryResults = await Promise.allSettled(
            pagesToCrawl.map(async (catUrl) => {
              const catController = new AbortController();
              const catTimer = setTimeout(() => catController.abort(), 6000);
              const catRes = await fetch(catUrl, {
                signal: catController.signal,
                redirect: 'follow',
                headers: {
                  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                  'Accept': 'text/html',
                },
              });
              clearTimeout(catTimer);
              if (!catRes.ok) return [];
              const catHtml = await catRes.text();
              return extractLinks(catHtml);
            })
          );

          for (const cr of categoryResults) {
            if (cr.status === 'fulfilled' && cr.value) {
              allLinks = [...allLinks, ...cr.value];
            }
          }
          allLinks = [...new Set(allLinks)]; // Deduplicate again
        }

        // Score links — require genuine product relevance
        const productPatterns = [
          /\/produs\//i, /\/product\//i, /\/pd\//i,
          /\/shop\/[^/]+/i, /\/magazin\/[^/]+/i,
          /\/item\//i, /\/articol\//i,
        ];
        // Broader category patterns (lower score)
        const categoryUrlPatterns = [
          /\/catalog\//i, /\/categori/i, /\/gama\//i,
        ];

        // Negative patterns — URLs that are clearly NOT product pages
        const negativePatterns = [
          /\/blog\//i, /\/news\//i, /\/stiri\//i, /\/articole\//i,
          /\/contact\b/i, /\/despre\b/i, /\/about\b/i, /\/privacy/i,
          /\/terms/i, /\/politica/i, /\/cookie/i, /\/gdpr/i,
          /\/login/i, /\/register/i, /\/cont\b/i, /\/account/i,
          /\/cos\b/i, /\/cart/i, /\/checkout/i, /\/wishlist/i,
          /\/faq/i, /\/support/i, /\/service\b/i, /\/garantie/i, /\/help\//i,
          /\/livrare\b/i, /\/retur\b/i, /\/plata\b/i, /\/transport\b/i,
          /\/recenzii\b/i, /\/reviews\b/i, /\/testimoniale\b/i,
          /\/media\//i, /\/press/i, /\/downloads/i,
          /\.(pdf|jpg|jpeg|png|gif|svg|webp|avif|ico|css|js|woff2?|ttf|eot)$/i,
          // Asset/static directories — never product pages
          /\/storage\//i, /\/assets\//i, /\/images\//i, /\/static\//i,
          /\/uploads\//i, /\/wp-content\/uploads\//i, /\/dist\//i, /\/build\//i,
          /\/cdn\//i, /\/_next\//i, /\/fonts\//i, /\/img\//i,
        ];

        let bestLink = '';
        let bestScore = 0;
        let bestHasPrimary = false;

        for (const link of allLinks) {
          if (isHomepageUrl(link)) continue;

          let score = 0;
          let hasPrimaryMatch = false;
          const linkLower = link.toLowerCase();
          const pathLower = new URL(link).pathname.toLowerCase();

          // Negative check — skip clearly non-product pages
          if (negativePatterns.some(p => p.test(pathLower))) continue;

          // URL pattern match (product page structure)
          let hasProductPattern = false;
          for (const pat of productPatterns) {
            if (pat.test(link)) { score += 3; hasProductPattern = true; break; }
          }
          if (!hasProductPattern) {
            for (const pat of categoryUrlPatterns) {
              if (pat.test(link)) { score += 1; break; }
            }
          }

          // Primary keyword match in URL (high value — these are the product terms)
          for (const kw of primaryKeywords) {
            if (pathLower.includes(kw)) {
              score += 4; // Higher weight for primary keywords
              hasPrimaryMatch = true;
            }
          }

          // Secondary keyword match in URL (lower value)
          for (const kw of secondaryKeywords) {
            if (pathLower.includes(kw)) score += 1;
          }

          // Search query keyword match
          for (const sw of searchKw) {
            if (pathLower.includes(sw)) {
              score += 2;
              // If search keyword is also a primary keyword, mark as primary match
              if (primaryKeywords.includes(sw)) hasPrimaryMatch = true;
            }
          }

          // Prefer deeper paths (more specific product pages)
          const pathDepth = (new URL(link).pathname.match(/\//g) || []).length;
          if (pathDepth >= 2) score += 1; // /category/product is better than /category
          if (pathDepth >= 3) score += 1;
          if (pathDepth >= 4) score += 1;

          // Prefer this link if: higher score, OR same score but deeper path (more specific)
          const currentDepth = bestLink ? (new URL(bestLink).pathname.match(/\//g) || []).length : 0;
          if (score > bestScore ||
              (score === bestScore && hasPrimaryMatch && !bestHasPrimary) ||
              (score === bestScore && hasPrimaryMatch && pathDepth > currentDepth)) {
            bestScore = score;
            bestLink = link;
            bestHasPrimary = hasPrimaryMatch;
          }
        }

        // Accept if score >= 3 (relaxed from 4+primary to allow more matches)
        // Primary keyword match still gives priority but is no longer required
        const confident = bestScore >= 3;

        map[i] = {
          productUrl: confident ? bestLink : '',
          website: s.website,
        };

        if (bestLink) {
          console.log(`[ProductSearch] ${s.name}: best candidate ${bestLink} (score: ${bestScore}, primary: ${bestHasPrimary}, accepted: ${confident})`);
        } else {
          console.log(`[ProductSearch] ${s.name}: no relevant product link found on ${s.website}`);
        }
      } catch {
        // Supplier website unreachable — leave empty
      }
    })
  );

  // Race: all crawls vs global timeout
  const raceResult = await Promise.race([crawlWork, globalTimeout]);
  if (raceResult === 'timeout') {
    console.warn('[ProductSearch] Hit global timeout — returning partial results');
  }

  return map;
}

// Verify a URL responds (HEAD, 6s timeout)
async function verifyUrl(url: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    clearTimeout(timer);
    return res.ok || res.status === 405 || res.status === 403; // 403/405 = server exists but restricts
  } catch {
    return false;
  }
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

// Load AI learning patterns from disk
async function loadLearnings(): Promise<string> {
  const data = await safeReadJSON<{ patterns: string[] }>(DATA_PATHS.AI_LEARNINGS, { patterns: [] });
  if (data.patterns?.length > 0) {
    return '\n\nÎNVĂȚĂMINTE DIN CĂUTĂRI ANTERIOARE (aplică aceste preferințe):\n' +
      data.patterns.slice(-10).map((p: string) => `- ${p}`).join('\n');
  }
  return '';
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
          if (violatesZone(s, spec.zone, spec.zoneLocation)) {
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
