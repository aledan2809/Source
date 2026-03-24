import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir, readFile } from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { runClaude, CLAUDE_TIMEOUTS } from '@/lib/claude';
import type { AIProviderSelection } from '@/lib/claude';
import { safeUpdateJSON, safeWriteJSON, DATA_PATHS, getResultPath } from '@/lib/file-operations';
import { validateFormData, checkRateLimit } from '@/lib/validation';
import { validateSourcing } from '@/lib/guardrails';
import { createPipeline, transition, computeQualityScore, STAGES, EVENTS, type PipelineState } from '@/lib/pipeline';

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
  const shortProductTerms = /^(atv|utv|4x4|2wd|4wd|suv|mpv|led|lcd|cnc|hvac|eps|abs|cvt|rar|ecu)$/i;
  // Patterns for technical specs that are important
  const techSpecs = /^\d+cc$|^\d+kw$|^\d+hp$|^\d+[vV]$|^\d+[wW]$/;

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
    const productCategoryPattern = /combusti|transmisi|automat|omolog|portant|recreat|competi|motor|vehicul|quad|moto|scuter|tractor|excavat|utilaj|echipament|industrial|electric|hidraulic|pneumatic|generator|compresor|pompa|sudur|frezat|strung|buldozer|macara|încărcăt|stivuitor/i;
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
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_CX) return null;

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
        const ddgQuery = s.productSearchQuery
          ? s.productSearchQuery.replace(/^site:\S+\s*/i, '')
          : primaryKeywords.join(' ');

        // Try with site restriction first
        let ddgUrl = await searchDuckDuckGo(`site:${hostname} ${ddgQuery}`);

        // If no result, try supplier name + product keywords
        if (!ddgUrl) {
          ddgUrl = await searchDuckDuckGo(`${s.name} ${ddgQuery}`);
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

        // Extract all links from the page
        const extractLinks = (pageHtml: string): string[] => {
          const linkMatches = pageHtml.matchAll(/href=["']([^"']+)["']/gi);
          const found: string[] = [];
          for (const m of linkMatches) {
            let href = m[1];
            if (href.startsWith('/')) href = baseUrl + href;
            if (href.startsWith('http') && href.includes(hostname)) {
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

        const pagesToCrawl = [...new Set([...categoryLinks, ...keywordCategoryLinks])].slice(0, 3); // Max 3 extra pages

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
  try {
    const p = path.join(process.cwd(), 'src', 'data', 'ai-learnings.json');
    const raw = await readFile(p, 'utf-8');
    const data = JSON.parse(raw) as { patterns: string[] };
    if (data.patterns?.length > 0) {
      return '\n\nÎNVĂȚĂMINTE DIN CĂUTĂRI ANTERIOARE (aplică aceste preferințe):\n' +
        data.patterns.slice(-10).map((p: string) => `- ${p}`).join('\n');
    }
  } catch { /* no learnings yet */ }
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

    const learnings = await loadLearnings();

    const budgetLine = spec.budgetMin || spec.budgetMax
      ? `- Buget MAXIM OBLIGATORIU: ${spec.budgetMin || '0'} - ${spec.budgetMax} ${spec.currency} ← RESPECTĂ STRICT, nu depăși acest buget`
      : '- Buget: Nespecificat';

    let userContent = `Generează pachetul complet de sourcing pentru:

DESCRIERE: ${spec.description}

DETALII TEHNICE (au prioritate absolută față de orice din descriere):
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
FEEDBACK UTILIZATOR PENTRU REZULTATUL ANTERIOR: ${spec.refinementFeedback}
Îmbunătățește rezultatul anterior ținând cont de feedback. Înlocuiește furnizorii nesatisfăcători, ajustează RFQ-ul și emailurile.`;
    }

    const prompt = `Ești un expert în achiziții și sourcing B2B din România și internațional.

IMPORTANT: Nu inventezi și nu halucinezi URL-uri sau date de contact. În schimb, pentru fiecare furnizor vei furniza un "productSearchQuery" — interogarea exactă cu care se va căuta pe Google/DuckDuckGo pagina de produs. Sistemul va face el căutarea reală și va găsi URL-ul corect.

Răspunde DOAR în format JSON valid, fără markdown, fără backticks:
{
  "summary": "Rezumat executiv al cererii",
  "suppliers": [
    {
      "name": "Nume Furnizor Real SRL",
      "website": "https://domeniu-real.ro",
      "productSearchQuery": "Furnizor SRL produs-specific categorie cumpara pret",
      "email": "contact@furnizor.ro",
      "phone": "+40 XXX XXX XXX",
      "country": "România",
      "notes": "De ce este relevant acest furnizor"
    }
  ],
  "rfq": "Document RFQ complet",
  "emails": [{"to": "contact@furnizor.ro", "subject": "...", "body": "..."}],
  "brief": "Brief sourcing markdown"
}

REGULI STRICTE:
1. FURNIZORI: Doar companii REALE și VERIFICABILE pe care le cunoști cu certitudine. Trebuie să poți confirma că firma există, are un site funcțional, și vinde efectiv produsul cerut.
2. INTERZIS: NU include marketplace-uri generice ca furnizori (OLX, Autovit, Publi24, Facebook Marketplace, Alibaba, AliExpress, Made-in-China, DHGate, Temu, Wish). Acestea sunt AGREGATORI, nu furnizori B2B.
3. INTERZIS: NU include magazine care NU vând tipul de produs cerut (ex: Dedeman/Praktiker/Hornbach/IKEA pentru ATV-uri, motociclete, echipamente sportive specializate, utilaje grele).
4. INTERZIS: NU inventa nume de firme. Dacă nu cunoști suficienți furnizori reali, returnează mai puțini (chiar și 1-2) dar REALI, decât 6 inventați. ZERO furnizori inventați.
5. website: Domeniul real al companiei — dacă nu ești 100% sigur că domeniul există, pune ""
6. productSearchQuery: Interogare specifică de tip "site:domeniu.ro produs exact". NU pune interogări generice.
7. email/phone: DOAR date de contact reale pe care le cunoști sigur. Dacă nu ești sigur, pune "" — NU inventa numere de telefon sau adrese de email.
8. NU include câmpuri priceMin/priceMax — prețurile vor fi extrase automat din paginile de produs reale. Nu inventa prețuri.
9. ZONĂ: Respectă STRICT zona geografică. Dacă zona este "Locală" sau "Regională", NU include furnizori din China sau alte țări care nu pot livra în termenul cerut.${learnings}

---

${userContent}`;

    // Create entry immediately with 'processing' status
    const id = spec.searchId || randomUUID();
    await mkdir(DATA_PATHS.RESULTS_DIR, { recursive: true });

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

    // Run Claude + web search in background (pipeline orchestrated)
    runClaude(prompt, { provider }).then(async (raw) => {
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

      // Use Claude CLI with web search to find real product URLs
      if (result.suppliers && result.suppliers.length > 0) {
        console.log(`[Source] Searching product URLs for ${result.suppliers.length} suppliers...`);
        const urlMap = await findProductUrls(result.suppliers, spec.description);

        // Apply found URLs and verify
        await Promise.all(result.suppliers.map(async (s, i) => {
          const found = urlMap[i];

          if (found) {
            // Update website if Claude found the real one
            if (found.website && !isHomepageUrl(found.website)) {
              // found.website should be just the domain — but verify it's not empty
              s.website = found.website;
            } else if (found.website) {
              s.website = found.website;
            }

            // CRITICAL: Reject productUrl if it's just a homepage
            if (found.productUrl && !isHomepageUrl(found.productUrl) && normalizeUrl(found.productUrl) !== normalizeUrl(s.website || '')) {
              // Verify the product URL actually works
              const ok = await verifyUrl(found.productUrl);
              if (ok) {
                s.productUrl = found.productUrl;
                s.urlVerified = true;
                s.urlSource = 'searched';
              } else {
                // Product URL doesn't work — leave empty, don't fall back to homepage
                s.productUrl = '';
                s.urlSource = 'unverified';
              }
            } else if (found.productUrl && isHomepageUrl(found.productUrl)) {
              console.log(`[Source] Rejected homepage as productUrl for ${s.name}: ${found.productUrl}`);
              s.productUrl = '';
            }
          }

          // If no product URL yet, verify at least the homepage
          if (!s.productUrl && s.website) {
            const ok = await verifyUrl(s.website);
            if (ok) {
              s.urlVerified = true;
              s.urlSource = 'verified';
            } else {
              s.website = '';
              s.urlVerified = false;
              s.urlSource = 'unverified';
            }
          }

          // Extract real price from verified product URL
          if (s.productUrl && s.urlVerified) {
            const realPrice = await fetchProductPrice(s.productUrl);
            if (realPrice) {
              s.priceMin = realPrice.price;
              s.priceMax = realPrice.price;
              s.priceCurrency = realPrice.currency;
              (s as unknown as Record<string, unknown>).priceSource = 'scraped';
              console.log(`[Source] Real price for ${s.name}: ${realPrice.price} ${realPrice.currency} from ${s.productUrl}`);
            } else {
              // Could not extract price — clear AI estimates to avoid misleading user
              s.priceMin = undefined;
              s.priceMax = undefined;
              (s as unknown as Record<string, unknown>).priceSource = 'unavailable';
              console.log(`[Source] Could not extract price for ${s.name} from ${s.productUrl}`);
            }
          } else {
            // No verified product URL — clear AI-hallucinated prices
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
      const errorEntry = { ...processingEntry, status: 'error', error: err.message, updatedAt: new Date().toISOString() };
      await safeWriteJSON(getResultPath(id), errorEntry);
      await safeUpdateJSON(DATA_PATHS.SEARCH_LOG, [], (log: Record<string, unknown>[]) => {
        const idx = log.findIndex((e: Record<string, unknown>) => e.id === id);
        if (idx >= 0) log[idx] = errorEntry; else log.push(errorEntry);
        return log;
      });
      console.error('Background generate error:', err);
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
