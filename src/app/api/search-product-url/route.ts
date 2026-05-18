import { NextRequest, NextResponse } from 'next/server';

const SEARCH_RATE_MAX = 10;
const SEARCH_RATE_WINDOW_MS = 60_000;
const searchCounters = new Map<string, { count: number; resetAt: number }>();
function checkSearchRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = searchCounters.get(ip);
  if (!entry || entry.resetAt < now) {
    searchCounters.set(ip, { count: 1, resetAt: now + SEARCH_RATE_WINDOW_MS });
    return true;
  }
  if (entry.count >= SEARCH_RATE_MAX) return false;
  entry.count++;
  return true;
}

const GOOGLE_CSE_API_KEY = process.env.GOOGLE_CSE_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || '';

interface SearchResult {
  productUrl: string;
  title: string;
  snippet: string;
  source: 'google_cse' | 'duckduckgo' | 'site_crawl' | 'none';
}

const AGGREGATOR_DOMAINS = [
  'olx.ro', 'olx.com', 'autovit.ro', 'publi24.ro', 'lajumate.ro',
  'facebook.com', 'alibaba.com', 'aliexpress.com', 'made-in-china.com',
  'dhgate.com', 'wish.com', 'temu.com', 'youtube.com', 'wikipedia.org',
  'emag.ro', 'amazon.com', 'ebay.com',
];

const NON_PRODUCT_PATTERNS = [
  /\/blog\//i, /\/news\//i, /\/stiri\//i, /\/contact\b/i, /\/despre\b/i,
  /\/about\b/i, /\/privacy/i, /\/terms/i, /\/politica/i, /\/cookie/i,
  /\/login/i, /\/register/i, /\/cart/i, /\/checkout/i, /\/faq/i,
  /\/support/i, /\/help\//i, /\/livrare\b/i, /\/retur\b/i,
  /\.(pdf|jpg|jpeg|png|gif|svg|webp|css|js)$/i,
  /\/assets\//i, /\/static\//i, /\/uploads\//i, /\/wp-content\/uploads\//i,
  /\/_next\//i, /\/cdn\//i, /\/img\//i, /\/images\//i,
];

function isHomepage(url: string): boolean {
  try {
    const parsed = new URL(url);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    return cleanPath === '' || cleanPath === '/';
  } catch {
    return true;
  }
}

function isAggregator(url: string): boolean {
  const lower = url.toLowerCase();
  return AGGREGATOR_DOMAINS.some(d => lower.includes(d));
}

function isNonProductPage(url: string): boolean {
  try {
    const p = new URL(url).pathname;
    return NON_PRODUCT_PATTERNS.some(pat => pat.test(p));
  } catch {
    return false;
  }
}

function isValidProductUrl(url: string): boolean {
  if (!url) return false;
  if (isHomepage(url)) return false;
  if (isAggregator(url)) return false;
  if (isNonProductPage(url)) return false;
  return true;
}

/**
 * Strategy 1: Google Custom Search API
 */
async function googleCSESearch(query: string, siteRestrict?: string): Promise<SearchResult | null> {
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_CX) {
    console.warn('[SearchProductUrl] Google CSE disabled — GOOGLE_CSE_API_KEY or GOOGLE_CSE_CX not set');
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
      console.error(`[SearchProductUrl] Google CSE error: ${res.status}`);
      return null;
    }

    const data = await res.json();
    for (const item of data.items || []) {
      const link: string = item.link || '';
      if (isValidProductUrl(link)) {
        return { productUrl: link, title: item.title || '', snippet: item.snippet || '', source: 'google_cse' };
      }
    }
    return null;
  } catch (err) {
    console.error('[SearchProductUrl] Google CSE error:', err);
    return null;
  }
}

/**
 * Strategy 2: DuckDuckGo HTML scraping (free, no API key needed)
 * Uses DuckDuckGo's HTML-only endpoint
 */
async function duckDuckGoSearch(query: string): Promise<SearchResult | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);

    // Use DuckDuckGo HTML lite version
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

    if (!res.ok) {
      console.error(`[SearchProductUrl] DuckDuckGo error: ${res.status}`);
      return null;
    }

    const html = await res.text();

    // Extract result links from DDG HTML (uses protocol-relative //duckduckgo.com/... URLs)
    const resultLinks: Array<{ url: string; title: string; snippet: string }> = [];

    const allHrefs = html.matchAll(/href="((?:https?:)?\/\/[^"]+)"/gi);
    for (const m of allHrefs) {
      let href = m[1];
      // Fix protocol-relative URLs
      if (href.startsWith('//')) href = 'https:' + href;
      // DDG uses redirect URLs with uddg parameter
      if (href.includes('duckduckgo.com')) {
        const uddgMatch = href.match(/uddg=([^&]+)/);
        if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);
        else continue;
      }
      if (href.startsWith('http') && !resultLinks.some(r => r.url === href)) {
        resultLinks.push({ url: href, title: '', snippet: '' });
      }
    }

    console.log(`[SearchProductUrl] DuckDuckGo found ${resultLinks.length} links for "${query}"`);

    for (const item of resultLinks) {
      if (isValidProductUrl(item.url)) {
        return { productUrl: item.url, title: item.title, snippet: item.snippet, source: 'duckduckgo' };
      }
    }

    return null;
  } catch (err) {
    console.error('[SearchProductUrl] DuckDuckGo error:', err);
    return null;
  }
}

/**
 * Strategy 3: Direct site crawl — fetch supplier homepage, extract links, score them
 */
async function siteCrawlSearch(
  domain: string,
  keywords: string[]
): Promise<SearchResult | null> {
  try {
    const baseUrl = domain.startsWith('http') ? new URL(domain).origin : `https://${domain}`;
    const hostname = new URL(baseUrl).hostname;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(baseUrl, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;

    const html = await res.text();

    // Extract all same-domain links
    const linkMatches = html.matchAll(/href=["']([^"']+)["']/gi);
    const links: string[] = [];
    for (const m of linkMatches) {
      let href = m[1];
      if (href.startsWith('/')) href = baseUrl + href;
      if (href.startsWith('http') && href.includes(hostname)) {
        links.push(href);
      }
    }
    const uniqueLinks = [...new Set(links)];

    // Also crawl category pages for deeper product links
    const categoryPatterns = [
      /\/categori/i, /\/produse\b/i, /\/products\b/i, /\/shop\b/i,
      /\/magazin\b/i, /\/catalog\b/i, /\/gama\b/i, /\/modele\b/i,
    ];

    const categoryLinks = uniqueLinks.filter(link => {
      try {
        const p = new URL(link).pathname.toLowerCase();
        return categoryPatterns.some(pat => pat.test(p)) ||
          keywords.some(kw => p.includes(kw.toLowerCase()));
      } catch { return false; }
    }).slice(0, 3);

    // Crawl category pages
    if (categoryLinks.length > 0) {
      const categoryResults = await Promise.allSettled(
        categoryLinks.map(async (catUrl) => {
          const c = new AbortController();
          const t = setTimeout(() => c.abort(), 6000);
          const r = await fetch(catUrl, {
            signal: c.signal, redirect: 'follow',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html' },
          });
          clearTimeout(t);
          if (!r.ok) return [];
          const h = await r.text();
          const found: string[] = [];
          for (const lm of h.matchAll(/href=["']([^"']+)["']/gi)) {
            let href = lm[1];
            if (href.startsWith('/')) href = baseUrl + href;
            if (href.startsWith('http') && href.includes(hostname)) found.push(href);
          }
          return found;
        })
      );
      for (const cr of categoryResults) {
        if (cr.status === 'fulfilled') uniqueLinks.push(...cr.value);
      }
    }

    const allLinks = [...new Set(uniqueLinks)];
    const kwLower = keywords.map(k => k.toLowerCase());

    // Score links
    let bestLink = '';
    let bestScore = 0;

    const productPatterns = [
      /\/produs\//i, /\/product\//i, /\/pd\//i,
      /\/shop\/[^/]+/i, /\/magazin\/[^/]+/i,
      /\/item\//i, /\/articol\//i,
    ];

    for (const link of allLinks) {
      if (!isValidProductUrl(link)) continue;

      let score = 0;
      const pathLower = new URL(link).pathname.toLowerCase();

      // Product URL pattern
      if (productPatterns.some(p => p.test(link))) score += 3;

      // Keyword matches in path
      for (const kw of kwLower) {
        if (kw.length >= 3 && pathLower.includes(kw)) score += 3;
      }

      // Path depth bonus
      const depth = (pathLower.match(/\//g) || []).length;
      if (depth >= 2) score += 1;
      if (depth >= 3) score += 1;

      if (score > bestScore) {
        bestScore = score;
        bestLink = link;
      }
    }

    // Lower threshold: score >= 3 (was 4 with primary keyword requirement)
    if (bestScore >= 3 && bestLink) {
      console.log(`[SearchProductUrl] Site crawl found: ${bestLink} (score: ${bestScore})`);
      return { productUrl: bestLink, title: '', snippet: '', source: 'site_crawl' };
    }

    return null;
  } catch (err) {
    console.error('[SearchProductUrl] Site crawl error:', err);
    return null;
  }
}

/**
 * POST /api/search-product-url
 * Body: { query: string, supplierDomain?: string, supplierName?: string, keywords?: string[] }
 * Returns: { productUrl, title, snippet, source }
 *
 * Also supports batch: { batch: [{ query, supplierDomain?, supplierName?, keywords? }] }
 * Returns: { results: [{ productUrl, title, snippet, source }] }
 */
export async function POST(request: NextRequest) {
  const ip = request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip') ?? 'local';
  if (!checkSearchRateLimit(ip)) {
    return NextResponse.json({ error: 'Too many requests — try again in a minute' }, { status: 429 });
  }
  try {
    const body = await request.json();

    // Batch mode
    if (body.batch && Array.isArray(body.batch)) {
      const results = await Promise.all(
        body.batch.map((item: { query: string; supplierDomain?: string; supplierName?: string; keywords?: string[] }) =>
          searchProductUrl(item.query, item.supplierDomain, item.supplierName, item.keywords || [])
        )
      );
      return NextResponse.json({ results });
    }

    // Single mode
    const { query, supplierDomain, supplierName, keywords } = body;

    if (!query) {
      return NextResponse.json({ error: 'Missing query parameter' }, { status: 400 });
    }

    const result = await searchProductUrl(query, supplierDomain, supplierName, keywords || []);
    return NextResponse.json(result);
  } catch (err) {
    console.error('[SearchProductUrl] Error:', err);
    return NextResponse.json({ error: 'Search failed' }, { status: 500 });
  }
}

async function searchProductUrl(
  query: string,
  supplierDomain?: string,
  supplierName?: string,
  keywords: string[] = []
): Promise<SearchResult> {
  const fullQuery = supplierName && !query.includes(supplierName)
    ? `${supplierName} ${query}`
    : query;

  console.log(`[SearchProductUrl] Searching: "${fullQuery}" (domain: ${supplierDomain || 'any'})`);

  // Strategy 1: Google CSE with site restriction
  if (supplierDomain) {
    const gResult = await googleCSESearch(query, supplierDomain);
    if (gResult) return gResult;
  }

  // Strategy 2: Google CSE without site restriction
  const gResult2 = await googleCSESearch(fullQuery);
  if (gResult2) return gResult2;

  // Strategy 3: DuckDuckGo with site restriction
  if (supplierDomain) {
    const ddgSite = await duckDuckGoSearch(`site:${supplierDomain} ${query}`);
    if (ddgSite) return ddgSite;
  }

  // Strategy 4: DuckDuckGo general search
  const ddgResult = await duckDuckGoSearch(fullQuery);
  if (ddgResult) return ddgResult;

  // Strategy 5: Direct site crawl
  if (supplierDomain) {
    const crawlKeywords = keywords.length > 0
      ? keywords
      : query.split(/\s+/).filter(w => w.length >= 3);
    const crawlResult = await siteCrawlSearch(supplierDomain, crawlKeywords);
    if (crawlResult) return crawlResult;
  }

  return { productUrl: '', title: '', snippet: '', source: 'none' };
}
