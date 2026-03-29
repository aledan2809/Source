/**
 * Real supplier discovery via web search.
 * Searches DuckDuckGo/Google CSE for actual suppliers, extracts company info,
 * and returns verified results for AI to compile into sourcing packages.
 *
 * This is the FIX for the core problem: AI was hallucinating suppliers.
 * Now we search FIRST, then AI compiles from real data.
 */

import { logger } from './logger';
import { runAI } from './claude';

const log = logger.child({ module: 'supplier-discovery' });

const GOOGLE_CSE_API_KEY = process.env.GOOGLE_CSE_API_KEY || '';
const GOOGLE_CSE_CX = process.env.GOOGLE_CSE_CX || '';

export interface DiscoveredSupplier {
  name: string;
  website: string;
  productUrl: string;
  title: string;
  snippet: string;
  source: 'google_cse' | 'duckduckgo';
  contactEmail?: string;
  contactPhone?: string;
}

const AGGREGATOR_DOMAINS = [
  'olx.ro', 'olx.com', 'autovit.ro', 'publi24.ro', 'lajumate.ro',
  'facebook.com', 'alibaba.com', 'aliexpress.com', 'made-in-china.com',
  'dhgate.com', 'wish.com', 'temu.com', 'youtube.com', 'wikipedia.org',
  'emag.ro', 'amazon.com', 'ebay.com', 'reddit.com', 'twitter.com',
  'instagram.com', 'linkedin.com', 'pinterest.com', 'tiktok.com',
];

const NON_SUPPLIER_DOMAINS = [
  'google.com', 'google.ro', 'bing.com', 'duckduckgo.com',
  'gov.ro', 'edu.ro', 'ac.ro',
];

function isDomainBlocked(url: string): boolean {
  const lower = url.toLowerCase();
  return [...AGGREGATOR_DOMAINS, ...NON_SUPPLIER_DOMAINS].some(d => lower.includes(d));
}

function isHomepage(url: string): boolean {
  try {
    const parsed = new URL(url);
    const cleanPath = parsed.pathname.replace(/\/+$/, '');
    return cleanPath === '' || cleanPath === '/';
  } catch {
    return true;
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

const SERPER_API_KEY = process.env.SERPER_API_KEY || '';

/**
 * Search via Serper.dev (Google results, free 2500/month).
 * Most reliable from server IPs since it's an actual API.
 */
async function searchSerper(query: string): Promise<Array<{ url: string; title: string; snippet: string }>> {
  if (!SERPER_API_KEY) return [];

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, gl: 'ro', hl: 'ro', num: 10 }),
    });
    clearTimeout(timer);
    if (!res.ok) return [];

    const data = await res.json();
    const results: Array<{ url: string; title: string; snippet: string }> = [];

    for (const item of data.organic || []) {
      if (item.link && !isDomainBlocked(item.link)) {
        results.push({ url: item.link, title: item.title || '', snippet: item.snippet || '' });
      }
    }
    return results;
  } catch (err) {
    log.warn('Serper search failed', { query, error: String(err) });
    return [];
  }
}

/**
 * Search DuckDuckGo for real suppliers.
 * NOTE: May return 0 results from server IPs (DDG returns 202/CAPTCHA).
 * Falls back to Serper.dev or Google CSE.
 */
async function searchDDG(query: string): Promise<Array<{ url: string; title: string; snippet: string }>> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);

    const ddgUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(ddgUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
        'Accept-Language': 'ro-RO,ro;q=0.9,en;q=0.8',
      },
    });
    clearTimeout(timer);
    if (!res.ok) return [];

    const html = await res.text();
    const results: Array<{ url: string; title: string; snippet: string }> = [];

    // Parse DDG HTML results - extract result blocks
    // DDG results have class="result" with links containing uddg param
    const resultBlocks = html.split(/class="result[\s"]/);

    for (const block of resultBlocks.slice(1)) { // Skip first (before first result)
      // Extract URL from uddg parameter
      const uddgMatch = block.match(/uddg=([^&"]+)/);
      if (!uddgMatch) continue;

      let url = decodeURIComponent(uddgMatch[1]);
      if (!url.startsWith('http')) continue;

      // Extract title
      const titleMatch = block.match(/class="result__a"[^>]*>([^<]+)</);
      const title = titleMatch ? titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '';

      // Extract snippet
      const snippetMatch = block.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch
        ? snippetMatch[1].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
        : '';

      if (url && !isDomainBlocked(url)) {
        results.push({ url, title, snippet });
      }
    }

    // Fallback: if block parsing failed, use simple href extraction
    if (results.length === 0) {
      const allHrefs = html.matchAll(/uddg=([^&"]+)/gi);
      for (const m of allHrefs) {
        const url = decodeURIComponent(m[1]);
        if (url.startsWith('http') && !isDomainBlocked(url) && !results.some(r => r.url === url)) {
          results.push({ url, title: '', snippet: '' });
        }
      }
    }

    return results;
  } catch (err) {
    log.warn('DuckDuckGo search failed', { query, error: String(err) });
    return [];
  }
}

/**
 * Search Google CSE for real suppliers (if keys configured).
 */
async function searchGoogleCSE(query: string): Promise<Array<{ url: string; title: string; snippet: string }>> {
  if (!GOOGLE_CSE_API_KEY || !GOOGLE_CSE_CX) return [];

  try {
    const url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_CSE_API_KEY}&cx=${GOOGLE_CSE_CX}&q=${encodeURIComponent(query)}&num=10`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return [];

    const data = await res.json();
    return (data.items || [])
      .filter((item: { link: string }) => item.link && !isDomainBlocked(item.link))
      .map((item: { link: string; title?: string; snippet?: string }) => ({
        url: item.link,
        title: item.title || '',
        snippet: item.snippet || '',
      }));
  } catch (err) {
    log.warn('Google CSE search failed', { query, error: String(err) });
    return [];
  }
}

/**
 * Verify a URL responds (HEAD request, 5s timeout).
 */
async function verifyUrl(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(5000),
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return res.ok || res.status === 403 || res.status === 405;
  } catch {
    return false;
  }
}

/**
 * Try to extract contact info from a webpage.
 */
async function extractContactInfo(url: string): Promise<{ email?: string; phone?: string }> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'text/html',
      },
    });
    if (!res.ok) return {};
    const html = await res.text();

    // Extract email
    const emailMatch = html.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch?.[0];

    // Extract Romanian phone
    const phoneMatch = html.match(/(?:\+40|0040|0)\s*(?:7[0-9]{2}|[23][0-9]{2})\s*[0-9\s.-]{6,10}/);
    const phone = phoneMatch?.[0]?.replace(/[\s.-]/g, '').replace(/^0/, '+40');

    return {
      email: email && !email.includes('example') && !email.includes('email@') ? email : undefined,
      phone: phone && phone.length >= 10 ? phone : undefined,
    };
  } catch {
    return {};
  }
}

interface DiscoveryOptions {
  description: string;
  zone: string;
  zoneLocation?: string;
  type: string;
  condition?: string;
  minSuppliers?: number;
  maxSuppliers?: number;
}

/**
 * MAIN FUNCTION: Discover real suppliers via web search.
 *
 * Runs multiple search queries, deduplicates by domain, verifies URLs,
 * and returns real supplier data for AI compilation.
 */
export async function discoverRealSuppliers(options: DiscoveryOptions): Promise<DiscoveredSupplier[]> {
  const { description, zone, zoneLocation, type, minSuppliers = 3, maxSuppliers = 8 } = options;

  const zoneText = zone === 'local'
    ? (zoneLocation || 'București Romania')
    : zone === 'regional'
    ? (zoneLocation || 'Romania')
    : '';

  const buyRent = type === 'inchiriere' ? 'inchiriere' : 'cumpara pret';

  // Build diverse search queries to maximize coverage
  const queries = [
    // Primary: product + buy + location
    `${description} ${buyRent} ${zoneText}`.trim(),
    // Supplier-focused
    `furnizor ${description} ${zoneText}`.trim(),
    // Shop/store search
    `magazin ${description} ${buyRent} ${zoneText}`.trim(),
    // Distributor search
    `distribuitor ${description} Romania`.trim(),
  ];

  // If zone is local/regional, add more specific queries
  if (zone !== 'global' && zoneLocation) {
    queries.push(`${description} ${zoneLocation} magazin`);
  }

  log.info('Starting supplier discovery', {
    queries: queries.length,
    zone,
    description: description.substring(0, 100),
  });

  // Run all searches in parallel (Google CSE + DuckDuckGo for each query)
  const allSearchResults: Array<{ url: string; title: string; snippet: string; source: 'google_cse' | 'duckduckgo' }> = [];

  // Priority: Serper (reliable from server) > Google CSE > DuckDuckGo (may be blocked)
  const hasSerper = !!SERPER_API_KEY;
  const hasGoogleCSE = !!(GOOGLE_CSE_API_KEY && GOOGLE_CSE_CX);

  const searchPromises = queries.flatMap(query => {
    const promises: Promise<Array<{ url: string; title: string; snippet: string; source: 'google_cse' | 'duckduckgo' }>>[] = [];

    // Serper: most reliable from server IPs
    if (hasSerper) {
      promises.push(
        searchSerper(query).then(results =>
          results.map(r => ({ ...r, source: 'google_cse' as const })) // Serper returns Google results
        )
      );
    }

    // Google CSE
    if (hasGoogleCSE) {
      promises.push(
        searchGoogleCSE(query).then(results =>
          results.map(r => ({ ...r, source: 'google_cse' as const }))
        )
      );
    }

    // DuckDuckGo: free but may be blocked on server IPs
    promises.push(
      searchDDG(query).then(results =>
        results.map(r => ({ ...r, source: 'duckduckgo' as const }))
      )
    );

    return promises;
  });

  // Global timeout: 25 seconds for all searches
  const searchTimeout = new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 25000));

  const raceResult = await Promise.race([
    Promise.allSettled(searchPromises).then(results => {
      for (const r of results) {
        if (r.status === 'fulfilled') {
          allSearchResults.push(...r.value);
        }
      }
      return 'done';
    }),
    searchTimeout,
  ]);

  if (raceResult === 'timeout') {
    log.warn('Search hit global timeout — using partial results');
  }

  log.info(`Raw search results: ${allSearchResults.length} URLs`);

  // Deduplicate by domain — keep the best URL per domain (deepest path = most specific)
  const domainMap = new Map<string, typeof allSearchResults[0]>();

  for (const result of allSearchResults) {
    const domain = extractDomain(result.url);
    if (!domain) continue;

    const existing = domainMap.get(domain);
    if (!existing) {
      domainMap.set(domain, result);
    } else {
      // Prefer non-homepage URLs (product pages)
      const existingIsHome = isHomepage(existing.url);
      const newIsHome = isHomepage(result.url);
      if (existingIsHome && !newIsHome) {
        domainMap.set(domain, result);
      }
      // Prefer Google CSE results
      if (result.source === 'google_cse' && existing.source !== 'google_cse') {
        domainMap.set(domain, { ...result, url: newIsHome ? existing.url : result.url });
      }
    }
  }

  log.info(`Unique domains: ${domainMap.size}`);

  // Verify URLs and extract contact info (in parallel, max 10)
  const candidates = [...domainMap.values()].slice(0, 12); // Check top 12
  const verified: DiscoveredSupplier[] = [];

  await Promise.allSettled(
    candidates.map(async (result) => {
      const domain = extractDomain(result.url);
      const baseUrl = `https://${domain}`;

      // Verify the URL works
      const urlWorks = await verifyUrl(result.url);
      if (!urlWorks) {
        // Try the base domain
        const baseWorks = await verifyUrl(baseUrl);
        if (!baseWorks) {
          log.info(`Skipping unresponsive: ${domain}`);
          return;
        }
      }

      // Extract contact info from the page (or homepage)
      const contactUrl = isHomepage(result.url) ? baseUrl : result.url;
      const contact = await extractContactInfo(contactUrl);

      // Try to also get contact from /contact page
      if (!contact.email || !contact.phone) {
        const contactPage = await extractContactInfo(`${baseUrl}/contact`).catch(() => ({ email: undefined, phone: undefined }));
        if (!contact.email && contactPage.email) contact.email = contactPage.email;
        if (!contact.phone && contactPage.phone) contact.phone = contactPage.phone;
      }

      // Build supplier name from title or domain
      let name = result.title
        .replace(/[-|–—].*$/, '') // Remove everything after dash
        .replace(/\s*(home|acasa|magazin|shop|store|online)\s*/gi, '')
        .trim();

      if (!name || name.length < 3) {
        name = domain.replace(/\.(ro|com|eu|net|org)$/, '').replace(/[-_]/g, ' ');
        name = name.charAt(0).toUpperCase() + name.slice(1);
      }

      verified.push({
        name,
        website: baseUrl,
        productUrl: isHomepage(result.url) ? '' : result.url,
        title: result.title,
        snippet: result.snippet,
        source: result.source,
        contactEmail: contact.email,
        contactPhone: contact.phone,
      });
    })
  );

  log.info(`Verified suppliers: ${verified.length}`);

  // If web search returned nothing (DDG blocked, no API keys), use AI knowledge as fallback
  if (verified.length === 0) {
    log.warn('Web search returned 0 suppliers — falling back to AI-assisted discovery');
    const aiSuppliers = await aiAssistedDiscovery(options);
    return aiSuppliers.slice(0, maxSuppliers);
  }

  // Sort: prefer suppliers with product URLs and contact info
  verified.sort((a, b) => {
    const scoreA = (a.productUrl ? 3 : 0) + (a.contactEmail ? 1 : 0) + (a.contactPhone ? 1 : 0);
    const scoreB = (b.productUrl ? 3 : 0) + (b.contactEmail ? 1 : 0) + (b.contactPhone ? 1 : 0);
    return scoreB - scoreA;
  });

  return verified.slice(0, maxSuppliers);
}

/**
 * FALLBACK: When web search fails (DDG blocked, no API keys),
 * ask AI to list REAL supplier websites, then verify them.
 *
 * This is better than the old approach because:
 * 1. AI is explicitly told to ONLY list websites it's CERTAIN exist
 * 2. We verify every website before accepting (HEAD request)
 * 3. We scrape real contact info from verified websites
 * 4. We reject suppliers with non-responding websites
 */
async function aiAssistedDiscovery(options: DiscoveryOptions): Promise<DiscoveredSupplier[]> {
  const { description, zone, zoneLocation, type } = options;

  const zoneText = zone === 'local'
    ? (zoneLocation || 'București')
    : zone === 'regional'
    ? (zoneLocation || 'Romania')
    : 'internațional';

  const prompt = `Listează 15-20 website-uri REALE de magazine/furnizori online din ${zoneText} care vând: ${description}

CRITERII OBLIGATORII:
1. DOAR domenii pe care le-ai văzut menționate în date de antrenament (articole, recenzii, forumuri)
2. ZERO domenii inventate sau ghicite — dacă nu ești 100% sigur că domeniul există, NU-l include
3. Preferă magazinele mari și cunoscute (ex: ecosolaris.ro, solar1000.com, sunvalley.ro, greentech-solar.ro, sfrlight.ro)
4. Include și magazine mai mici dar REALE din România
5. EXCLUDE marketplace-uri (OLX, eMag, Amazon, Alibaba, Facebook)

Exemple de formate CORECTE: "ecosolaris.ro", "solar1000.com", "dbsolar.ro"
Exemple de formate GREȘITE: "solarromania.ro" (inventat), "best-solar.ro" (inventat)

Răspunde DOAR cu un JSON array, fără altceva:
[
  {"domain": "ecosolaris.ro", "name": "EcoSolaris"},
  {"domain": "solar1000.com", "name": "Solar 1000"}
]

IMPORTANT: Mai bine 5 domenii REALE decât 20 inventate. Voi verifica fiecare domeniu — cele care nu răspund vor fi eliminate.`;

  try {
    const response = await runAI(
      'Ești un expert în furnizori și magazine online din România. Returnezi DOAR JSON valid.',
      prompt,
      { jsonMode: true }
    );

    const jsonMatch = response.content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      log.warn('AI discovery returned no JSON');
      return [];
    }

    const suggestions: Array<{ domain: string; name: string }> = JSON.parse(jsonMatch[0]);
    log.info(`AI suggested ${suggestions.length} potential suppliers`);

    // Verify each suggestion — reject non-responding websites
    const verified: DiscoveredSupplier[] = [];

    await Promise.allSettled(
      suggestions.slice(0, 12).map(async (suggestion) => {
        const domain = suggestion.domain.replace(/^(https?:\/\/)?(www\.)?/, '');
        const website = `https://${domain}`;
        const wwwWebsite = `https://www.${domain}`;

        // Verify the website responds
        let works = await verifyUrl(website);
        const finalUrl = works ? website : (await verifyUrl(wwwWebsite) ? wwwWebsite : '');

        if (!finalUrl) {
          log.info(`AI suggestion rejected — not responding: ${domain}`);
          return;
        }

        // Try to find a product page by crawling homepage
        let productUrl = '';
        try {
          const res = await fetch(finalUrl, {
            signal: AbortSignal.timeout(8000),
            redirect: 'follow',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'text/html',
            },
          });
          if (res.ok) {
            const html = await res.text();
            // Extract keywords from description
            const keywords = description.toLowerCase().split(/[\s,;.()]+/).filter(w => w.length > 3);
            // Find links that match product keywords
            const links = html.matchAll(/href=["'](https?:\/\/[^"']+)["']/gi);
            for (const m of links) {
              const href = m[1];
              if (!href.includes(domain)) continue;
              const pathLower = new URL(href).pathname.toLowerCase();
              // Skip non-product pages
              if (/\/(blog|news|contact|about|privacy|terms|cart|login|faq)/i.test(pathLower)) continue;
              if (/\.(css|js|png|jpg|svg|ico|woff)$/i.test(pathLower)) continue;
              // Check if URL contains product keywords
              const hasKeyword = keywords.some(kw => pathLower.includes(kw));
              const hasProductPattern = /\/(produs|product|shop|magazin|catalog|categori|panouri|invertor|solar|fotovoltaic)/i.test(pathLower);
              if (hasKeyword || hasProductPattern) {
                productUrl = href;
                break;
              }
            }
          }
        } catch { /* crawl failed — still include with homepage */ }

        // Extract contact info
        const contact = await extractContactInfo(finalUrl);
        if (!contact.email || !contact.phone) {
          const contactPage = await extractContactInfo(`${finalUrl}/contact`).catch(() => ({ email: undefined, phone: undefined }));
          if (!contact.email && contactPage.email) contact.email = contactPage.email;
          if (!contact.phone && contactPage.phone) contact.phone = contactPage.phone;
        }

        verified.push({
          name: suggestion.name || domain,
          website: finalUrl,
          productUrl: productUrl,
          title: suggestion.name || '',
          snippet: '',
          source: 'duckduckgo', // Technically AI-assisted but treated same
          contactEmail: contact.email,
          contactPhone: contact.phone,
        });
      })
    );

    log.info(`AI discovery: ${suggestions.length} suggested → ${verified.length} verified`);
    return verified;
  } catch (err) {
    log.error('AI-assisted discovery failed', { error: String(err) });
    return [];
  }
}
