/**
 * Sourcing Validation Pipeline — State Machine
 *
 * Adapted from Master AI Pipeline (mesh/engine/pipeline-state.js).
 * Same architecture pattern, but applied to sourcing data instead of code.
 *
 * Master Pipeline:  idle → planning → dev → ci → guardrails → qa → deploy → done
 * Sourcing Pipeline: idle → generate → parse → guardrails → verify → quality → [review] → done
 *
 * Each stage has: handler function, timeout, retry logic, pass/fail/flag transitions.
 */

/* ═══════════════════════════════════════════════════════════════
   States & Events
   ═══════════════════════════════════════════════════════════════ */

export const STAGES = {
  IDLE: 'idle',
  GENERATE: 'generate',         // AI generates supplier list (≈ Master DEV)
  PARSE: 'parse',               // Validate JSON structure + required fields (≈ Master CI)
  GUARDRAILS: 'guardrails',     // NeMo LLM + local rules: hallucination detection (≈ Master GUARDRAILS)
  VERIFY: 'verify',             // URL checks, price scraping, email domain (≈ Master QA)
  QUALITY_CHECK: 'quality',     // Overall quality score — decide: pass / retry / flag (≈ Master DEPLOY)
  REVIEW: 'review',             // Human review for flagged results (≈ Master WAITING_GUARDRAILS)
  DONE: 'done',
  FAILED: 'failed',
} as const;

export type Stage = typeof STAGES[keyof typeof STAGES];

export const EVENTS = {
  START: 'start',
  SUCCESS: 'success',
  FAILURE: 'failure',
  SKIP: 'skip',
  FLAG: 'flag',           // Needs human review
  RETRY: 'retry',         // Retry current or previous stage
} as const;

export type Event = typeof EVENTS[keyof typeof EVENTS];

// State → Event → Next State
const TRANSITIONS: Record<string, Record<string, Stage>> = {
  [STAGES.IDLE]: {
    [EVENTS.START]: STAGES.GENERATE,
  },
  [STAGES.GENERATE]: {
    [EVENTS.SUCCESS]: STAGES.PARSE,
    [EVENTS.FAILURE]: STAGES.FAILED,
  },
  [STAGES.PARSE]: {
    [EVENTS.SUCCESS]: STAGES.GUARDRAILS,
    [EVENTS.FAILURE]: STAGES.GENERATE,  // Bad JSON → retry generation (max 2)
  },
  [STAGES.GUARDRAILS]: {
    [EVENTS.SUCCESS]: STAGES.VERIFY,    // All checks passed
    [EVENTS.FLAG]: STAGES.REVIEW,       // High-severity issues → human review
    [EVENTS.FAILURE]: STAGES.FAILED,    // Critical issue (all suppliers rejected)
    [EVENTS.SKIP]: STAGES.VERIFY,       // Guardrails disabled
  },
  [STAGES.VERIFY]: {
    [EVENTS.SUCCESS]: STAGES.QUALITY_CHECK,
    [EVENTS.FAILURE]: STAGES.QUALITY_CHECK, // Some URLs failed — still proceed to quality
    [EVENTS.SKIP]: STAGES.QUALITY_CHECK,
  },
  [STAGES.QUALITY_CHECK]: {
    [EVENTS.SUCCESS]: STAGES.DONE,      // Quality sufficient
    [EVENTS.FAILURE]: STAGES.GENERATE,  // Quality too low → retry (max 2)
    [EVENTS.FLAG]: STAGES.REVIEW,       // Borderline quality → human review
  },
  [STAGES.REVIEW]: {
    [EVENTS.SUCCESS]: STAGES.DONE,      // Human approved
    [EVENTS.FAILURE]: STAGES.GENERATE,  // Human rejected → regenerate
    [EVENTS.SKIP]: STAGES.DONE,         // Human bypassed
  },
  [STAGES.FAILED]: {
    [EVENTS.RETRY]: STAGES.GENERATE,
  },
};

/* ═══════════════════════════════════════════════════════════════
   Pipeline State
   ═══════════════════════════════════════════════════════════════ */

export interface StageResult {
  event: Event;
  data?: unknown;
  issues?: Array<{ severity: 'critical' | 'high' | 'medium' | 'low'; message: string }>;
  duration_ms?: number;
}

export interface PipelineState {
  id: string;
  currentStage: Stage;
  startedAt: string;
  updatedAt: string;
  retries: number;
  maxRetries: number;
  stageHistory: Array<{
    stage: Stage;
    event: Event;
    timestamp: string;
    duration_ms?: number;
    issues_count?: number;
  }>;
  guardrailsResult?: {
    engine: string;
    flagged: boolean;
    rejected_count: number;
    issues: unknown[];
  };
  qualityScore?: number;   // 0-100
  supplierCount?: number;
  verifiedCount?: number;
  pricesScrapedCount?: number;
}

/**
 * Create a new pipeline state.
 */
export function createPipeline(id: string, maxRetries: number = 2): PipelineState {
  const now = new Date().toISOString();
  return {
    id,
    currentStage: STAGES.IDLE,
    startedAt: now,
    updatedAt: now,
    retries: 0,
    maxRetries,
    stageHistory: [],
  };
}

/**
 * Transition the pipeline to a new state based on an event.
 * Returns the new state, or null if the transition is invalid.
 */
export function transition(pipeline: PipelineState, event: Event, stageResult?: StageResult): PipelineState | null {
  const currentTransitions = TRANSITIONS[pipeline.currentStage];
  if (!currentTransitions) return null;

  const nextStage = currentTransitions[event];
  if (!nextStage) return null;

  // Check retry limit
  if ((event === EVENTS.FAILURE || event === EVENTS.RETRY) && nextStage === STAGES.GENERATE) {
    if (pipeline.retries >= pipeline.maxRetries) {
      // Max retries reached → force FAILED
      return {
        ...pipeline,
        currentStage: STAGES.FAILED,
        updatedAt: new Date().toISOString(),
        stageHistory: [
          ...pipeline.stageHistory,
          {
            stage: pipeline.currentStage,
            event,
            timestamp: new Date().toISOString(),
            duration_ms: stageResult?.duration_ms,
            issues_count: stageResult?.issues?.length,
          },
        ],
      };
    }
  }

  const isRetry = nextStage === STAGES.GENERATE && pipeline.currentStage !== STAGES.IDLE;

  return {
    ...pipeline,
    currentStage: nextStage,
    updatedAt: new Date().toISOString(),
    retries: isRetry ? pipeline.retries + 1 : pipeline.retries,
    stageHistory: [
      ...pipeline.stageHistory,
      {
        stage: pipeline.currentStage,
        event,
        timestamp: new Date().toISOString(),
        duration_ms: stageResult?.duration_ms,
        issues_count: stageResult?.issues?.length,
      },
    ],
  };
}

/* ═══════════════════════════════════════════════════════════════
   Quality Score Calculator
   ═══════════════════════════════════════════════════════════════ */

export interface QualityInput {
  totalSuppliers: number;
  suppliersWithWebsite: number;
  suppliersWithVerifiedUrl: number;
  suppliersWithScrapedPrice: number;
  suppliersWithEmail: number;
  suppliersWithPhone: number;
  guardrailsRejected: number;
  guardrailsFlagged: number;
}

/**
 * Compute an overall quality score (0-100) for the sourcing result.
 *
 * Scoring breakdown:
 * - Base: 20 points if at least 1 supplier
 * - URL verification: 0-25 points (% of suppliers with verified URLs)
 * - Price data: 0-20 points (% of suppliers with scraped prices)
 * - Contact completeness: 0-15 points (% with email + phone)
 * - Guardrails: 0-20 points (deduct for rejections/flags)
 *
 * Thresholds:
 * - ≥70: PASS → show to user
 * - 40-69: FLAG → show with warning, suggest regeneration
 * - <40: FAIL → auto-retry or show with strong warning
 */
export function computeQualityScore(input: QualityInput): {
  score: number;
  decision: 'pass' | 'flag' | 'fail';
  breakdown: Record<string, number>;
} {
  if (input.totalSuppliers === 0) {
    return { score: 0, decision: 'fail', breakdown: {} };
  }

  const t = input.totalSuppliers;

  const base = 20;
  const urlScore = Math.round((input.suppliersWithVerifiedUrl / t) * 25);
  const priceScore = Math.round((input.suppliersWithScrapedPrice / t) * 20);
  const contactScore = Math.round(((input.suppliersWithEmail + input.suppliersWithPhone) / (t * 2)) * 15);
  const guardrailsDeduction = Math.round(((input.guardrailsRejected + input.guardrailsFlagged * 0.5) / t) * 20);
  const guardrailsScore = Math.max(0, 20 - guardrailsDeduction);

  const score = Math.min(100, base + urlScore + priceScore + contactScore + guardrailsScore);

  const decision: 'pass' | 'flag' | 'fail' =
    score >= 70 ? 'pass' :
    score >= 40 ? 'flag' :
    'fail';

  return {
    score,
    decision,
    breakdown: { base, urlScore, priceScore, contactScore, guardrailsScore },
  };
}

/* ═══════════════════════════════════════════════════════════════
   Pipeline Runner (orchestrates all stages)
   ═══════════════════════════════════════════════════════════════ */

export interface PipelineConfig {
  /** Max retries for generate stage. Default 2 */
  maxRetries?: number;
  /** Skip guardrails entirely. Default false */
  skipGuardrails?: boolean;
  /** Skip URL verification. Default false */
  skipVerify?: boolean;
  /** Minimum quality score to auto-pass. Default 70 */
  qualityPassThreshold?: number;
  /** Minimum quality score before auto-fail. Default 40 */
  qualityFailThreshold?: number;
  /** Suspiciously low price threshold for guardrails. Default 0.50 */
  suspiciouslyLowPriceThreshold?: number;
}

export const DEFAULT_PIPELINE_CONFIG: Required<PipelineConfig> = {
  maxRetries: 2,
  skipGuardrails: false,
  skipVerify: false,
  qualityPassThreshold: 70,
  qualityFailThreshold: 40,
  suspiciouslyLowPriceThreshold: 0.50,
};
