// Generic AI route handler — powered by ai-router
// POST /api/ai — Chat with any AI provider (round-robin, fallback, health tracking)
// GET  /api/ai — Provider info, health status, available providers

import { AIRouter, getProjectPreset, ALL_PROVIDER_IDS, getProviderConfig } from 'ai-router';
import { NextRequest } from 'next/server';

const preset = getProjectPreset('source');
const router = new AIRouter({ ...preset });

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      messages,
      provider = preset.defaultProvider || 'auto',
      model,
      maxTokens,
      temperature,
      jsonMode,
    } = body;

    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return Response.json(
        { error: 'messages is required and must be a non-empty array' },
        { status: 400 }
      );
    }

    const response = await router.chat({
      messages,
      provider,
      model,
      maxTokens,
      temperature,
      jsonMode,
    });

    return Response.json(response);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    console.error('[ai-router] source error:', message);
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  const health = router.getHealth();
  const available = router.getAvailableProviders();
  const config = router.getConfig();

  const providers = ALL_PROVIDER_IDS.map((id) => {
    const cfg = getProviderConfig(id);
    return {
      id: cfg.id,
      name: cfg.name,
      label: cfg.label,
      tier: cfg.tier,
      available: available.includes(id),
      enabled: config.providers.includes(id),
    };
  });

  return Response.json({
    projectName: config.projectName,
    defaultProvider: config.defaultProvider,
    providers,
    health,
    availableProviders: available,
  });
}
