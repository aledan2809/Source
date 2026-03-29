import { AIRouter, getProjectPreset } from 'ai-router';
import type { AIProviderSelection, AIResponse } from 'ai-router';

export interface ClaudeOptions {
  allowedTools?: string[];
  timeoutMs?: number;
  /** AI provider to use (default: from project preset, i.e. "claude") */
  provider?: AIProviderSelection;
}

// Singleton router instance — initialized with Source preset
// Providers order: claude, gemini, mistral, groq, openai, cohere, together, fireworks
const sourcePreset = getProjectPreset('source');
const router = new AIRouter({
  ...sourcePreset,
  // Source-specific: higher token limits for long sourcing prompts
  maxInputChars: undefined, // no truncation — sourcing prompts are large
  maxRetries: 2,
  providerOverrides: {
    claude: { maxTokens: 4096, temperature: 0.3 },
    gemini: { maxTokens: 4096, temperature: 0.3 },
    groq: { maxTokens: 4096, temperature: 0.3 },
    mistral: { maxTokens: 4096, temperature: 0.3 },
    cohere: { maxTokens: 4096, temperature: 0.3 },
    together: { maxTokens: 4096, temperature: 0.3 },
    fireworks: { maxTokens: 4096, temperature: 0.3 },
    openai: { maxTokens: 4096, temperature: 0.3 },
  },
});

/**
 * Run AI — routes through ai-router with round-robin, fallback, and health tracking.
 * Default provider: claude (best for Romanian B2B knowledge).
 * Fallback chain: claude → gemini → mistral → groq → openai → cohere → together → fireworks
 *
 * @param prompt - The prompt to send
 * @param options - Optional settings (timeoutMs, provider override)
 * @returns The AI response text
 */
export async function runClaude(prompt: string, options?: ClaudeOptions): Promise<string> {
  const response: AIResponse = await router.chat({
    messages: [{ role: 'user', content: prompt }],
    provider: options?.provider || 'auto', // 'auto' enables fallback chain across all providers
  });

  console.log(`[AI] Using: ${response.provider}${response.fallback ? ` (fallback from ${response.fallbackFrom})` : ''} | ${response.latencyMs}ms`);
  return response.content;
}

/**
 * Run AI with system message — for structured prompts that need a system context.
 * Uses ai-router under the hood.
 */
export async function runAI(
  systemPrompt: string,
  userPrompt: string,
  options?: ClaudeOptions & { jsonMode?: boolean }
): Promise<AIResponse> {
  const response = await router.chat({
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    provider: options?.provider || 'auto', // 'auto' enables fallback chain
    jsonMode: options?.jsonMode,
  });

  console.log(`[AI] Using: ${response.provider}${response.fallback ? ` (fallback from ${response.fallbackFrom})` : ''} | ${response.latencyMs}ms`);
  return response;
}

/**
 * Run AI with quality validation — if the response fails quality check,
 * retry with a different provider (up to maxRetries different providers).
 * Used for sourcing where low-quality providers return fabricated suppliers.
 */
export async function runClaudeWithQualityRetry(
  prompt: string,
  qualityCheck: (raw: string) => Promise<{ pass: boolean; reason?: string }> | { pass: boolean; reason?: string },
  options?: ClaudeOptions & { maxProviderRetries?: number }
): Promise<string> {
  const maxRetries = options?.maxProviderRetries ?? 2;
  const triedProviders: string[] = [];
  const availableProviders = router.getAvailableProviders();

  let lastContent = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response: AIResponse = await router.chat({
        messages: [{ role: 'user', content: prompt }],
        provider: options?.provider || 'auto',
        // On retry, hint that we want quality over speed
        speedVsQuality: attempt > 0 ? 0 : 0.3,
      });

      lastContent = response.content;
      const check = await Promise.resolve(qualityCheck(response.content));
      triedProviders.push(response.provider);

      if (check.pass) {
        console.log(`[AI] Using: ${response.provider} (attempt ${attempt + 1}) | ${response.latencyMs}ms | Quality: PASS`);
        return response.content;
      }

      console.warn(`[AI] Quality FAIL from ${response.provider} (attempt ${attempt + 1}): ${check.reason}`);

      if (attempt < maxRetries) {
        // Mark provider as unhealthy so router picks a DIFFERENT one next time
        const health = router.getHealth().find(h => h.id === response.provider);
        if (health) {
          health.healthy = false;
          health.totalCalls += 10;
          health.totalErrors += 10;
          health.successRate = 0;
          health.lastCheck = Date.now(); // Reset cooldown timer
        }
        console.log(`[AI] Retrying with different provider (tried: ${triedProviders.join(', ')})`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[AI] Provider error on attempt ${attempt + 1}: ${msg.substring(0, 150)}`);
      // Don't throw — try next attempt
    }
  }

  // Restore health for tried providers (don't pollute future requests)
  for (const pid of triedProviders) {
    const health = router.getHealth().find(h => h.id === pid);
    if (health) {
      health.healthy = true;
      health.successRate = 0.5;
    }
  }

  // All retries exhausted — return best available content
  if (lastContent) {
    console.warn(`[AI] All ${maxRetries + 1} attempts failed quality. Using best available response (tried: ${triedProviders.join(', ')})`);
    return lastContent;
  }

  // True fallback: try any provider directly
  console.warn(`[AI] Emergency fallback — trying any available provider`);
  const response = await router.chat({
    messages: [{ role: 'user', content: prompt }],
    provider: 'auto',
  });
  return response.content;
}

/** Export the router instance for direct access (health checks, etc.) */
export { router as aiRouter };
export type { AIProviderSelection, AIResponse };

/**
 * Constants for consistent timeouts across the app
 */
export const CLAUDE_TIMEOUTS = {
  INTERPRET: 60000,    // 1 minute for interpret
  GENERATE: 120000,    // 2 minutes for generate
  SEARCH: 180000,      // 3 minutes for web search
} as const;
