/**
 * AI Learning Engine — learns from per-supplier feedback to improve future results.
 *
 * Stores structured learnings (good/bad suppliers, patterns) and generates
 * a context block that gets injected into the AI prompt for generate.
 */

import { safeReadJSON, safeUpdateJSON, DATA_PATHS } from './file-operations';
import { logger } from './logger';
import path from 'path';

const log = logger.child({ module: 'learnings' });

const LEARNINGS_PATH = path.join(process.cwd(), 'src', 'data', 'ai-learnings.json');

export interface SupplierFeedback {
  searchId: string;
  supplierName: string;
  supplierDomain: string;
  rating: 'good' | 'bad';
  comment?: string;
  productCategory: string; // extracted from search description
  timestamp: string;
}

export interface LearningsData {
  // Legacy patterns (kept for compat)
  patterns: string[];

  // Structured supplier feedback
  supplierFeedback: SupplierFeedback[];

  // Aggregated domain reputation (computed from feedback)
  domainReputation: Record<string, {
    domain: string;
    goodCount: number;
    badCount: number;
    lastComment?: string;
    categories: string[]; // product categories this domain was good/bad for
  }>;

  // Rules extracted by AI from feedback patterns
  aiRules: string[];

  // Last time AI analyzed feedback to extract rules
  lastAnalysis?: string;
}

const DEFAULT_LEARNINGS: LearningsData = {
  patterns: [],
  supplierFeedback: [],
  domainReputation: {},
  aiRules: [],
};

/**
 * Record feedback for a specific supplier.
 */
export async function recordSupplierFeedback(feedback: SupplierFeedback): Promise<void> {
  await safeUpdateJSON(LEARNINGS_PATH, DEFAULT_LEARNINGS, (data: LearningsData) => {
    // Add to feedback log (keep last 200)
    data.supplierFeedback = data.supplierFeedback || [];
    data.supplierFeedback.push(feedback);
    if (data.supplierFeedback.length > 200) {
      data.supplierFeedback = data.supplierFeedback.slice(-200);
    }

    // Update domain reputation
    data.domainReputation = data.domainReputation || {};
    const domain = feedback.supplierDomain;
    if (domain) {
      if (!data.domainReputation[domain]) {
        data.domainReputation[domain] = { domain, goodCount: 0, badCount: 0, categories: [] };
      }
      const rep = data.domainReputation[domain];
      if (feedback.rating === 'good') rep.goodCount++;
      else rep.badCount++;
      if (feedback.comment) rep.lastComment = feedback.comment;
      if (feedback.productCategory && !rep.categories.includes(feedback.productCategory)) {
        rep.categories.push(feedback.productCategory);
      }
    }

    return data;
  });

  log.info('Recorded supplier feedback', {
    supplier: feedback.supplierName,
    domain: feedback.supplierDomain,
    rating: feedback.rating,
  });
}

/**
 * Generate learning context for AI prompt injection.
 * Returns a formatted string that gets appended to the generate prompt.
 */
export async function generateLearningContext(productDescription: string): Promise<string> {
  const data = await safeReadJSON<LearningsData>(LEARNINGS_PATH, DEFAULT_LEARNINGS);

  const sections: string[] = [];

  // 1. Trusted domains (consistently good feedback)
  const trustedDomains = Object.values(data.domainReputation || {})
    .filter(r => r.goodCount > 0 && r.goodCount > r.badCount)
    .sort((a, b) => b.goodCount - a.goodCount)
    .slice(0, 15);

  if (trustedDomains.length > 0) {
    sections.push(
      'FURNIZORI VERIFICAȚI ȘI APRECIAȚI DE UTILIZATOR (preferă aceștia):\n' +
      trustedDomains.map(d =>
        `  ✅ ${d.domain} (${d.goodCount} aprecieri${d.categories.length ? `, categorii: ${d.categories.join(', ')}` : ''})`
      ).join('\n')
    );
  }

  // 2. Blacklisted domains (consistently bad feedback)
  const blacklisted = Object.values(data.domainReputation || {})
    .filter(r => r.badCount > 0 && r.badCount >= r.goodCount)
    .sort((a, b) => b.badCount - a.badCount)
    .slice(0, 15);

  if (blacklisted.length > 0) {
    sections.push(
      'FURNIZORI RESPINȘI DE UTILIZATOR (NU îi include):\n' +
      blacklisted.map(d =>
        `  ❌ ${d.domain} (${d.badCount} respingeri${d.lastComment ? ` — motiv: "${d.lastComment}"` : ''})`
      ).join('\n')
    );
  }

  // 3. Recent negative feedback with comments (learning from mistakes)
  const recentNegative = (data.supplierFeedback || [])
    .filter(f => f.rating === 'bad' && f.comment)
    .slice(-10);

  if (recentNegative.length > 0) {
    sections.push(
      'GREȘELI ANTERIOARE (evită să repeți):\n' +
      recentNegative.map(f =>
        `  - ${f.supplierName}: "${f.comment}" (categorie: ${f.productCategory})`
      ).join('\n')
    );
  }

  // 4. AI-extracted rules
  if (data.aiRules && data.aiRules.length > 0) {
    sections.push(
      'REGULI ÎNVĂȚATE DIN FEEDBACK:\n' +
      data.aiRules.map(r => `  - ${r}`).join('\n')
    );
  }

  // 5. Legacy patterns
  if (data.patterns && data.patterns.length > 0) {
    sections.push(
      'PATTERN-URI DIN CĂUTĂRI ANTERIOARE:\n' +
      data.patterns.slice(-5).map(p => `  - ${p}`).join('\n')
    );
  }

  if (sections.length === 0) return '';

  return '\n\nÎNVĂȚĂMINTE DIN FEEDBACK UTILIZATOR (aplică obligatoriu):\n' + sections.join('\n\n');
}

/**
 * Periodically analyze feedback and extract AI rules.
 * Called after every N feedbacks or on demand.
 */
export async function analyzeAndExtractRules(runAI: (system: string, user: string) => Promise<string>): Promise<void> {
  const data = await safeReadJSON<LearningsData>(LEARNINGS_PATH, DEFAULT_LEARNINGS);

  // Only analyze if we have enough new feedback (at least 5 since last analysis)
  const lastAnalysis = data.lastAnalysis ? new Date(data.lastAnalysis) : new Date(0);
  const newFeedback = (data.supplierFeedback || []).filter(f =>
    new Date(f.timestamp) > lastAnalysis
  );

  if (newFeedback.length < 5) return;

  log.info(`Analyzing ${newFeedback.length} new feedbacks to extract rules`);

  const feedbackSummary = newFeedback.map(f =>
    `${f.rating === 'good' ? '👍' : '👎'} ${f.supplierName} (${f.supplierDomain}) — ${f.productCategory}${f.comment ? `: "${f.comment}"` : ''}`
  ).join('\n');

  try {
    const response = await runAI(
      'Ești un analist de procurement care extrage reguli din feedback-ul utilizatorilor.',
      `Analizează acest feedback despre furnizori și extrage 3-5 reguli concrete pentru viitoarele căutări de sourcing.

FEEDBACK:
${feedbackSummary}

DOMENII APRECIATE: ${trustedDomainsStr(data)}
DOMENII RESPINSE: ${blacklistedStr(data)}

Extrage reguli concrete, de forma:
- "Pentru panouri fotovoltaice, preferă ecosolaris.ro și solar1000.com"
- "Evită furnizori care vând doar en-gros pentru cereri de cantitate mică"
- "Utilizatorul preferă furnizori cu showroom în București"

Răspunde DOAR cu un JSON array de string-uri:
["regulă 1", "regulă 2", "regulă 3"]`
    );

    const match = response.match(/\[[\s\S]*\]/);
    if (match) {
      const rules: string[] = JSON.parse(match[0]);
      await safeUpdateJSON(LEARNINGS_PATH, DEFAULT_LEARNINGS, (d: LearningsData) => {
        d.aiRules = rules.slice(0, 10);
        d.lastAnalysis = new Date().toISOString();
        return d;
      });
      log.info(`Extracted ${rules.length} AI rules from feedback`);
    }
  } catch (err) {
    log.warn('Failed to extract AI rules', { error: String(err) });
  }
}

function trustedDomainsStr(data: LearningsData): string {
  return Object.values(data.domainReputation || {})
    .filter(r => r.goodCount > r.badCount)
    .map(r => r.domain)
    .join(', ') || 'niciun domeniu apreciat încă';
}

function blacklistedStr(data: LearningsData): string {
  return Object.values(data.domainReputation || {})
    .filter(r => r.badCount >= r.goodCount && r.badCount > 0)
    .map(r => r.domain)
    .join(', ') || 'niciun domeniu respins încă';
}
