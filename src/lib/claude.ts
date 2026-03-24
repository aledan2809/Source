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
    provider: options?.provider || sourcePreset.defaultProvider || 'claude',
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
    provider: options?.provider || sourcePreset.defaultProvider || 'claude',
    jsonMode: options?.jsonMode,
  });

  console.log(`[AI] Using: ${response.provider}${response.fallback ? ` (fallback from ${response.fallbackFrom})` : ''} | ${response.latencyMs}ms`);
  return response;
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
