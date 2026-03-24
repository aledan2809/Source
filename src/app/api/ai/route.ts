// Generic AI route handler — powered by ai-router
// POST /api/ai — Chat with any AI provider (round-robin, fallback, health tracking)
// GET  /api/ai — Provider info, health status, available providers

import { createAIRouteHandler } from 'ai-router/next';

const handler = createAIRouteHandler({ projectName: 'source' });

export const POST = handler.POST;
export const GET = handler.GET;
